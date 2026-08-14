import { SAMPLES, GROUPS } from "./data/samples.js";
import { ENZYMES, lookup, endType, siteWithCut, bufferWarning,
         overhangSignature, compatibleEnds } from "./enzymes.js";
import { digest, findCuts } from "./digest.js";
import { suggestDigests, excisionOptions } from "./suggest.js";
import { renderGel, LADDERS, PFGE_RUNS, laddersFor } from "./gel.js";
import { parseAny, sequenceStats, featuresInRange, featuresCutBy, PROTECTED_FEATURES } from "./genbank.js";
import { initAssistant, registerAssistantApp } from "./assistant.js";
import { searchSamples, searchNcbi } from "./dna-search.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  dnaKey: null,     // sample key, or null when a custom sequence is loaded
  dnaName: "",
  seq: "",
  circular: true,
  features: [],     // annotations from a GenBank record, when available
  lanes: [],        // [{ enzymeNames: [...] }]
  selected: new Set(), // enzyme names ticked but not yet added as a lane
  gelMode: "agarose", // "agarose" (constant field) | "pfge" (CHEF)
  gelPct: 1,
  pfgeRun: "medium",
  ladderKey: "1kb",
  exposure: 1,      // gel-doc style exposure multiplier
  contrast: 0.5,    // gamma of the intensity transfer curve
  methylation: "dam_dcm",
  search: "",
  tier: 2,
  cutFilter: "any",  // "any" | "cutters" | "unique"
  dnaSearch: "",
};

// ---------- DNA loading ----------
// Lanes are kept when the DNA changes: they store enzyme names, so their
// digests recompute against the new sequence on the next render.
function loadDna(name, seq, circular, key = null, features = []) {
  state.dnaKey = key;
  state.dnaName = name;
  state.seq = seq;
  state.circular = circular;
  state.features = features;
  // Any import status describes how the *previous* sequence arrived, so it is
  // stale the moment this one loads. Left standing it sat directly under the
  // new sequence's own line, naming a different molecule — the two together
  // read as a question about which one is actually loaded. Callers that have
  // something to add set it again after this returns.
  setImportStatus("");
  renderAll();
}

// ---------- User-supplied sequences ----------
const USER_KEY = "virge-sequences";

function readUserSeqs() {
  try {
    const v = JSON.parse(localStorage.getItem(USER_KEY));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function saveUserSeq(rec) {
  const store = readUserSeqs();
  let name = rec.name;
  for (let i = 2; store[name] && store[name].sequence !== rec.sequence; i++) name = `${rec.name} (${i})`;
  store[name] = { ...rec, name };
  localStorage.setItem(USER_KEY, JSON.stringify(store));
  return name;
}

function setImportStatus(msg, isError = false) {
  const el = $("#import-status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

// Topology: honour an explicit choice, else the record's own LOCUS line,
// else assume a plasmid, which is what most pasted sequences are.
function chosenTopology(record) {
  const pick = document.querySelector('input[name="topo"]:checked')?.value || "auto";
  if (pick === "circular") return true;
  if (pick === "linear") return false;
  return record.circular ?? true;
}

/** Accept parsed records from any source: paste, file, or accession fetch. */
function acceptRecords(records, origin) {
  if (records.length === 0) { setImportStatus(`${origin}: no DNA sequence found.`, true); return; }
  const usable = records.filter((r) => r.sequence.length >= 20);
  if (usable.length === 0) { setImportStatus(`${origin}: sequence too short (min 20 bp).`, true); return; }

  const rec = usable[0];
  const circular = chosenTopology(rec);
  const stored = saveUserSeq({
    name: rec.name || origin,
    accession: rec.accession || "",
    sequence: rec.sequence,
    features: rec.features || [],
    topology: circular ? "circular" : "linear",
  });
  loadDna(stored, rec.sequence, circular, `user:${stored}`, rec.features || []);
  // Length, GC, features and ambiguous bases are all on the sequence's own line
  // above, so repeating them here only invited the reader to check whether the
  // two agreed. Say only what that line cannot: that a multi-record file had
  // more in it than the one now loaded.
  if (usable.length > 1) {
    setImportStatus(`First of ${usable.length} records — the rest are in Your sequences.`);
  }
  // Multi-record files: keep the others so they show up in Saved sequences.
  for (const extra of usable.slice(1)) {
    saveUserSeq({
      name: extra.name, accession: extra.accession || "", sequence: extra.sequence,
      features: extra.features || [], topology: (extra.circular ?? false) ? "circular" : "linear",
    });
  }
  renderDnaGroups();
}

// ---------- NCBI name search ----------
/**
 * Deliberately a picker, not an oracle.
 *
 * Every hit is listed with its accession, length, topology and molecule type,
 * and the user chooses. Auto-loading the top hit would be a confident wrong
 * answer often enough to be dangerous: NCBI's first five records for "COVID 19"
 * are Klebsiella pneumoniae plasmids, and its results for "pET-28a" contain a
 * patent fragment and a clam mRNA but not the vector.
 */
async function runNcbiSearch() {
  const term = $("#ncbi-query").value.trim();
  const results = $("#ncbi-results"), status = $("#ncbi-status");
  if (!term) return;

  results.hidden = true;
  results.innerHTML = "";
  status.textContent = `Searching NCBI for “${term}”…`;
  status.classList.remove("error");

  try {
    const { total, hits } = await searchNcbi(term);
    if (!hits.length) {
      status.textContent = `Nothing on NCBI for “${term}”.`;
      return;
    }
    status.textContent = total > hits.length
      ? `${total.toLocaleString()} records match; showing the first ${hits.length}. Pick one — NCBI ranks by recency, not relevance.`
      : `${hits.length} record${hits.length === 1 ? "" : "s"}.`;

    results.innerHTML = hits.map((h) => `
      <button class="ncbi-hit${h.digestible ? "" : " undigestible"}"
              data-acc="${escapeHtml(h.accession)}" ${h.digestible ? "" : "disabled"}
              title="${escapeHtml(h.title)}">
        <span class="ncbi-title">${escapeHtml(h.title)}</span>
        <span class="hint">${[
          escapeHtml(h.accession),
          `${Number(h.length).toLocaleString()} bp`,
          h.topology ? escapeHtml(h.topology) : null,
          h.caveat ? `<em>${escapeHtml(h.caveat)}</em>` : null,
        ].filter(Boolean).join(" · ")}</span>
      </button>`).join("");
    results.hidden = false;

    results.querySelectorAll(".ncbi-hit").forEach((b) =>
      b.addEventListener("click", () => {
        $("#accession-input").value = b.dataset.acc;
        fetchAccession(b.dataset.acc);
      }));
  } catch (err) {
    status.textContent = `NCBI search failed: ${err.message}`;
    status.classList.add("error");
  }
}

// ---------- UI: grouped DNA picker ----------
const openGroups = new Set(); // group of the initial DNA is added in initSamples

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function dnaItemHtml(key, s, removable = false) {
  const cached = s.lazy && lazyCache.has(key);
  const detail = s.lazy && !cached ? " · download" : s.features?.length ? ` · ${s.features.length} feat` : "";
  return `
    <div class="dna-line">
      <button class="dna-item${key === state.dnaKey ? " active" : ""}${s.lazy && !cached ? " lazy" : ""}" data-key="${escapeHtml(key)}">
        <span class="dna-name">${escapeHtml(s.name)}</span>
        <span class="dna-size">${s.length.toLocaleString()} bp · ${s.topology}${detail}</span>
      </button>
      ${removable ? `<button class="btn ghost small del-seq" data-name="${escapeHtml(s.name)}" title="Remove saved sequence">✕</button>` : ""}
    </div>`;
}

// Large records ship as metadata only; fetch the sequence the first time one is
// selected and keep it for the rest of the session.
const lazyCache = new Map();

async function loadLazySample(key, s) {
  if (lazyCache.has(key)) {
    const c = lazyCache.get(key);
    loadDna(s.name, c.sequence, s.topology === "circular", key, c.features);
    return;
  }
  setImportStatus(`Fetching ${s.name} (${s.length.toLocaleString()} bp) from NCBI…`);
  document.body.classList.add("busy");
  try {
    const rettype = s.fetchAs === "fasta" ? "fasta" : "gbwithparts";
    const url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi" +
                `?db=nuccore&id=${encodeURIComponent(s.accession)}&rettype=${rettype}&retmode=text`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`NCBI returned ${res.status}`);
    const recs = parseAny(await res.text(), s.name);
    if (!recs.length) throw new Error("no sequence in the response");
    const rec = recs[0];
    if (rec.sequence.length !== s.length) {
      throw new Error(`expected ${s.length.toLocaleString()} bp but received ${rec.sequence.length.toLocaleString()}`);
    }
    lazyCache.set(key, { sequence: rec.sequence, features: rec.features || [] });
    // No receipt: loadDna clears the "Fetching…" line, and the sequence's own
    // line now reads the same name, length and feature count this used to.
    loadDna(s.name, rec.sequence, s.topology === "circular", key, rec.features || []);
  } catch (err) {
    setImportStatus(`Could not fetch ${s.name}: ${err.message}`, true);
  } finally {
    document.body.classList.remove("busy");
  }
}

function renderDnaGroups() {
  const wrap = $("#dna-groups");
  wrap.innerHTML = "";

  const userSeqs = readUserSeqs();

  // Name search, over the catalog and over a curated list of things we
  // deliberately do not carry. A query that matches nothing is a dead end; a
  // query that matches nothing *and explains why* is an answer.
  const { keys, note } = searchSamples(state.dnaSearch, SAMPLES);
  const noteBox = $("#dna-search-note");
  noteBox.hidden = !note;
  if (note) noteBox.textContent = `${note.title} — ${note.reason}`;
  const matches = keys && new Set(keys);

  const groups = [
    ...GROUPS.map((g) => ({
      title: g,
      items: Object.entries(SAMPLES)
        .filter(([k, s]) => s.group === g && (!matches || matches.has(k)))
        .sort(([, a], [, b]) => a.name.localeCompare(b.name)),
      removable: false,
    })),
  ].filter((g) => g.items.length || !matches);

  const userItems = Object.entries(userSeqs)
    .map(([name, s]) => [`user:${name}`, { ...s, length: s.sequence.length }])
    .filter(([, s]) => !matches || s.name.toLowerCase().includes(state.dnaSearch.toLowerCase()))
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
  if (userItems.length) {
    groups.unshift({ title: "Your sequences", items: userItems, removable: true });
  }

  if (matches && !groups.length) {
    wrap.innerHTML = `<p class="hint">No sample matches “${escapeHtml(state.dnaSearch)}”.` +
      ` You can still fetch it by accession, or search NCBI, below.</p>`;
    return;
  }

  for (const { title, items, removable } of groups) {
    const det = document.createElement("details");
    // While filtering, open every group that still has hits — a match hidden
    // inside a collapsed group reads as no match at all.
    det.open = matches ? true : openGroups.has(title);
    det.innerHTML =
      `<summary>${escapeHtml(title)} <span class="count">${items.length}</span></summary>` +
      items.map(([key, s]) => dnaItemHtml(key, s, removable)).join("");

    det.querySelector("summary").addEventListener("click", () => {
      setTimeout(() => (det.open ? openGroups.add(title) : openGroups.delete(title)));
    });
    det.querySelectorAll(".dna-item").forEach((b) =>
      b.addEventListener("click", () => {
        const key = b.dataset.key;
        const s = key.startsWith("user:") ? readUserSeqs()[key.slice(5)] : SAMPLES[key];
        if (!s) return;
        if (s.lazy) loadLazySample(key, s);
        else loadDna(s.name, s.sequence, s.topology === "circular", key, s.features || []);
      })
    );
    det.querySelectorAll(".del-seq").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const store = readUserSeqs();
        delete store[b.dataset.name];
        localStorage.setItem(USER_KEY, JSON.stringify(store));
        if (state.dnaKey === `user:${b.dataset.name}`) initSamples();
        else renderDnaGroups();
      })
    );
    wrap.appendChild(det);
  }
}

function initSamples() {
  const key = "pBR322"; // richly annotated, so fragment labelling is visible up front
  const s = SAMPLES[key];
  openGroups.add(s.group);
  loadDna(s.name, s.sequence, s.topology === "circular", key, s.features);
}

/** parseAny, with ParseError reported to the user rather than thrown away. */
function parseOrReport(text, origin) {
  try {
    return parseAny(text, origin);
  } catch (err) {
    setImportStatus(`${origin}: ${err.message}`, true);
    return null;
  }
}

$("#load-seq").addEventListener("click", () => {
  const text = $("#seq-input").value;
  if (!text.trim()) { setImportStatus("Nothing pasted yet.", true); return; }
  const recs = parseOrReport(text, "pasted sequence");
  if (recs) acceptRecords(recs, "pasted sequence");
});

// --- file import: picker and drag-and-drop ---
async function importFile(file) {
  if (!file) return;
  if (file.size > 40 * 1024 * 1024) { setImportStatus("File is larger than 40 MB.", true); return; }
  setImportStatus(`Reading ${file.name}…`);
  try {
    const text = await file.text();
    const recs = parseOrReport(text, file.name);
    if (recs) acceptRecords(recs, file.name);
  } catch (err) {
    setImportStatus(`Could not read ${file.name}: ${err.message}`, true);
  }
}

$("#pick-file").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  importFile(f);
});

const dz = $("#dropzone");
for (const evt of ["dragenter", "dragover"]) {
  dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.add("over"); });
}
for (const evt of ["dragleave", "drop"]) {
  dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.remove("over"); });
}
dz.addEventListener("drop", (e) => importFile(e.dataTransfer?.files?.[0]));

// --- fetch by accession from NCBI ---
async function fetchAccession(acc) {
  const id = acc.trim();
  if (!id) return;
  if (!/^[A-Za-z0-9_.]+$/.test(id)) { setImportStatus("That doesn't look like an accession.", true); return; }
  setImportStatus(`Fetching ${id} from NCBI…`);
  $("#fetch-accession").disabled = true;
  try {
    // gbwithparts resolves CON (contig) records, which carry no sequence of
    // their own and would otherwise come back as an annotation-only stub.
    const url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi" +
                `?db=nuccore&id=${encodeURIComponent(id)}&rettype=gbwithparts&retmode=text`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`NCBI returned ${res.status}`);
    const text = await res.text();
    if (/^\s*$/.test(text) || /Error|Failed to retrieve/i.test(text.slice(0, 200))) {
      throw new Error("no record found for that accession");
    }
    const recs = parseOrReport(text, id);
    if (recs) acceptRecords(recs, id);
  } catch (err) {
    setImportStatus(`Fetch failed: ${err.message}`, true);
  } finally {
    $("#fetch-accession").disabled = false;
  }
}

$("#fetch-accession").addEventListener("click", () => fetchAccession($("#accession-input").value));

$("#ncbi-search").addEventListener("click", runNcbiSearch);
$("#ncbi-query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); runNcbiSearch(); }
});

$("#dna-search").addEventListener("input", (e) => {
  state.dnaSearch = e.target.value;
  renderDnaGroups();
});
$("#accession-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") fetchAccession(e.target.value);
});

// ---------- UI: enzymes ----------
// The checkbox grid is rebuilt on every render, so the selection lives in
// state.selected rather than in the DOM.
// Cut counts are recomputed for every enzyme on each render; cache per
// (sequence, methylation) so scrolling and filtering stay instant with 200
// enzymes in the catalog.
let cutCache = { key: "", counts: new Map() };
function cutCountFor(enzyme) {
  const key = `${state.dnaName}:${state.seq.length}:${state.circular}:${state.methylation}`;
  if (cutCache.key !== key) cutCache = { key, counts: new Map() };
  if (!cutCache.counts.has(enzyme.name)) {
    cutCache.counts.set(
      enzyme.name,
      state.seq ? findCuts(state.seq, enzyme, state.circular, state.methylation).length : 0
    );
  }
  return cutCache.counts.get(enzyme.name);
}

function visibleEnzymes() {
  const q = state.search.trim().toLowerCase();
  return ENZYMES.filter((e) => {
    // An enzyme you have already ticked always stays visible, so a selection
    // can never silently vanish when a filter changes.
    if (state.selected.has(e.name)) return true;
    if (e.tier > state.tier) return false;
    if (q) {
      const hay = [e.name, ...(e.aliases || [])].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.cutFilter !== "any") {
      const n = cutCountFor(e);
      // "Unique" is the cloning-relevant filter: an enzyme that cuts exactly
      // once linearises a plasmid and gives a single insertion point.
      if (state.cutFilter === "cutters" && n === 0) return false;
      if (state.cutFilter === "unique" && n !== 1) return false;
    }
    return true;
  });
}

function renderEnzymes() {
  const wrap = $("#enzyme-list");
  wrap.innerHTML = "";
  const list = visibleEnzymes();
  for (const e of list) {
    const nCuts = cutCountFor(e);
    const label = document.createElement("label");
    label.className = "enzyme" + (nCuts === 0 ? " nocut" : "") + (e.typeIIS ? " iis" : "");
    const sig = overhangSignature(e);
    label.title = [
      e.name + (e.aliases?.length ? ` (aka ${e.aliases.slice(0, 2).join(", ")})` : ""),
      `${endType(e)}${sig.seq ? ` — ${sig.kind} ${sig.seq}` : sig.kind === "variable" ? " — sequence set by flanking DNA" : ""}`,
      `Incubate at ${e.temp}°C`,
      e.suppliers?.length ? `Sold by ${e.suppliers.slice(0, 4).join(", ")}${e.suppliers.length > 4 ? "…" : ""}` : "No commercial source listed",
    ].join("\n");
    label.innerHTML = `
      <input type="checkbox" value="${e.name}" ${state.selected.has(e.name) ? "checked" : ""} />
      <span class="ename">${e.name}</span>
      <span class="esite">${siteWithCut(e)}</span>
      <span class="ecuts">${nCuts}×</span>`;
    label.querySelector("input").addEventListener("change", (ev) => {
      ev.target.checked ? state.selected.add(e.name) : state.selected.delete(e.name);
      renderSelectionState();
    });
    wrap.appendChild(label);
  }
  const qualifier = { cutters: " that cut this DNA", unique: " cutting exactly once" }[state.cutFilter] || "";
  $("#enzyme-count").textContent = list.length === 0
    ? "No enzymes match these filters"
    : `${list.length} of ${ENZYMES.length} enzymes${state.search ? " matching" : qualifier}`;
  renderSelectionState();
}

$("#enzyme-search").addEventListener("input", (e) => { state.search = e.target.value; renderEnzymes(); });
$("#tier-filter").addEventListener("change", (e) => { state.tier = +e.target.value; renderEnzymes(); });
$("#cut-filter").addEventListener("change", (e) => { state.cutFilter = e.target.value; renderEnzymes(); });
$("#methylation").addEventListener("change", (e) => { state.methylation = e.target.value; renderAll(); });

/**
 * "Will this destroy my insert?" — the question a bench scientist asks before
 * committing to a digest.
 *
 * Suggest has always avoided cutting through genes when picking a cloning
 * digest, but hand-picking the same enzymes said nothing, on the same DNA with
 * the same annotations already loaded. This closes that asymmetry; both paths
 * go through featuresCutBy(), so they cannot disagree about what counts.
 *
 * Silent when the DNA carries no annotations, rather than implying safety it
 * cannot check.
 */
function renderFeatureWarning(chosen) {
  const box = $("#feature-warning");
  if (!chosen.length || !state.features.length) { box.hidden = true; box.textContent = ""; return; }

  // findCuts is per-enzyme; the selection is a single tube, so pool them.
  const cuts = [...new Set(chosen.flatMap((e) =>
    findCuts(state.seq, e, state.circular, state.methylation)))].sort((a, b) => a - b);
  const hits = featuresCutBy(cuts, state.features);
  if (!hits.length) { box.hidden = true; box.textContent = ""; return; }

  // Both counts are over distinct things, because GenBank routinely annotates
  // one gene twice — pBR322 carries `tet` as both a `gene` and a `CDS`, so a
  // single EcoRV cut matches two features. Summing them claimed "2 cuts" on a
  // plasmid EcoRV cuts once.
  const named = [...new Set(hits.map((h) => h.label).filter(Boolean))];
  const positions = new Set(hits.flatMap((h) => h.cuts));
  const shown = named.slice(0, 4).join(", ");
  const rest = named.length > 4 ? ` +${named.length - 4} more` : "";
  const n = positions.size;
  box.textContent =
    `${n} cut${n === 1 ? " lands" : "s land"} inside ${named.length} annotated ` +
    `feature${named.length === 1 ? "" : "s"}${shown ? `: ${shown}${rest}` : ""}.`;
  box.hidden = false;
}

// Keep the selection-dependent buttons honest about what they will do.
function renderSelectionState() {
  const n = state.selected.size;
  $("#add-lane").disabled = n === 0;
  $("#add-lane").textContent = n === 0 ? "Add lane with selection →" : `Add lane: ${[...state.selected].join(" + ")} →`;
  $("#clear-sel").disabled = n === 0;

  // Warn before the lane is created if the combination can't share one tube.
  const chosen = [...state.selected].map(lookup).filter(Boolean);
  const warn = bufferWarning(chosen);
  $("#buffer-warning").textContent = warn || "";
  $("#buffer-warning").hidden = !warn;

  renderFeatureWarning(chosen);

  // Sticky ends: what each enzyme leaves, and what it will ligate to.
  const box = $("#ends-info");
  if (chosen.length === 0) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = chosen.map((e) => {
    const sig = overhangSignature(e);
    const partners = compatibleEnds(e);
    const end = sig.kind === "variable"
      ? `<em>overhang set by flanking DNA</em> (Type IIS — programmable)`
      : sig.kind === "blunt" ? "<em>blunt</em>" : `${sig.kind} <code>${sig.seq}</code>`;
    const lig = partners.length
      ? `<span class="hint">ligates with ${partners.slice(0, 6).join(", ")}${partners.length > 6 ? ` +${partners.length - 6}` : ""}</span>`
      : "";
    return `<div class="end-row"><strong>${e.name}</strong> ${end} ${lig}</div>`;
  }).join("");
}

$("#add-lane").addEventListener("click", () => {
  if (state.selected.size === 0) return;
  state.lanes.push({ enzymeNames: [...state.selected] });
  state.selected.clear();
  renderAll();
});

$("#clear-sel").addEventListener("click", () => {
  state.selected.clear();
  renderEnzymes();
});

$("#clear-lanes").addEventListener("click", () => {
  state.lanes = [];
  renderAll();
});

$("#suggest-digests").addEventListener("click", () => {
  // Suggest replaces the gel rather than appending to it: the picks are chosen
  // as a set that reads well together, so mixing them into whatever was already
  // loaded gives a gel that is neither. `existing` is therefore empty — the
  // lanes about to be cleared must not veto the digests replacing them.
  const picks = suggestDigests(state.seq, state.circular, {
    count: 3,
    existing: [],
    methylation: state.methylation,
    features: state.features,          // so it won't propose cutting through genes
    purpose: $("#suggest-purpose").value,
  });
  // The purpose filters are strict enough to legitimately find nothing — a
  // small plasmid may have no clean cloning option at all. Say so rather than
  // leaving the button looking broken.
  if (picks.length === 0) {
    const label = $("#suggest-purpose").selectedOptions[0].textContent.replace(/^for /, "");
    $("#suggest-note").textContent =
      `Nothing suitable for ${label} on this DNA under the current methylation setting — ` +
      `try another purpose, or widen the enzyme tier.`;
    $("#suggest-note").hidden = false;
    return;
  }
  $("#suggest-note").hidden = true;
  // Cleared only now that there is something to put in their place — a purpose
  // with no suitable digest returns above with the gel untouched.
  state.lanes = picks.map((names) => ({ enzymeNames: names }));
  renderAll();
});

$("#suggest-purpose").addEventListener("change", () => { $("#suggest-note").hidden = true; });

// ---------- Cut out a feature ----------
// Below this, "cutting the feature out" is meaningless: the excised fragment
// would be essentially all flanking DNA, and purifying the band would tell you
// nothing about the feature. pBR322 annotates its rep_origin as a *single base*
// (position 2535) — real GenBank data rather than a parse artefact, and not
// something you can cut out.
const MIN_EXCISABLE_BP = 100;

/** Named genes and origins worth excising. Hidden entirely on unannotated DNA
 *  rather than offering an empty control. */
function exciseTargets() {
  const seen = new Set();
  return state.features.filter((f) => {
    if (!f.label || !PROTECTED_FEATURES.has(f.type)) return false;
    const bp = Math.max(...f.segments.map((s) => s.end)) - Math.min(...f.segments.map((s) => s.start));
    if (bp < MIN_EXCISABLE_BP) return false;
    // pBR322 carries tet as both a gene and a CDS; one entry per gene.
    if (seen.has(f.label)) return false;
    seen.add(f.label);
    return true;
  });
}

function renderExciseTargets() {
  const targets = exciseTargets();
  $("#excise-row").hidden = targets.length === 0;
  if (!targets.length) return;
  const keep = $("#excise-feature").value;
  $("#excise-feature").innerHTML = targets
    .map((f, i) => {
      const bp = Math.max(...f.segments.map((s) => s.end)) - Math.min(...f.segments.map((s) => s.start));
      return `<option value="${i}">${escapeHtml(f.label)} · ${bp.toLocaleString()} bp</option>`;
    }).join("");
  if (targets[keep]) $("#excise-feature").value = keep;
}

$("#excise-go").addEventListener("click", () => {
  const feature = exciseTargets()[$("#excise-feature").value];
  if (!feature) return;

  const options = excisionOptions(state.seq, state.circular, feature, {
    methylation: state.methylation,
    tier: state.tier,
  });

  const note = $("#suggest-note");
  if (!options.length) {
    note.textContent =
      `No enzyme in this tier cuts ${feature.label} out cleanly — every candidate either ` +
      `cuts inside it or cannot share a tube with its partner. Try widening the tier.`;
    note.hidden = false;
    return;
  }

  const best = options[0];
  note.textContent =
    `${best.names.join(" + ")} cuts ${feature.label} out in a ${best.size.toLocaleString()} bp ` +
    `fragment — ${best.upstream.toLocaleString()} bp upstream and ` +
    `${best.downstream.toLocaleString()} bp downstream come with it.`;
  note.hidden = false;

  // Same convention as Suggest: replace the gel, since the options are meant to
  // be compared against each other rather than against whatever was loaded.
  state.lanes = options.map((o) => ({ enzymeNames: o.names }));
  renderAll();
});

// ---------- Configuration library (localStorage) ----------
const LIB_KEY = "virge-library";

function readLibrary() {
  try {
    const lib = JSON.parse(localStorage.getItem(LIB_KEY));
    return lib && typeof lib === "object" && !Array.isArray(lib) ? lib : {};
  } catch {
    return {};
  }
}

function writeLibrary(lib) {
  localStorage.setItem(LIB_KEY, JSON.stringify(lib));
  renderLibrary();
}

function currentConfig() {
  const cfg = {
    savedAt: new Date().toISOString(),
    lanes: state.lanes.map((l) => ({ enzymeNames: [...l.enzymeNames] })),
    gelMode: state.gelMode,
    gelPct: state.gelPct,
    pfgeRun: state.pfgeRun,
    ladderKey: state.ladderKey,
    exposure: state.exposure,
    contrast: state.contrast,
    methylation: state.methylation,
  };
  if (state.dnaKey && !state.dnaKey.startsWith("user:")) {
    cfg.dna = { sample: state.dnaKey };
  } else {
    // Custom sequence: embed it (and its annotations) so the config travels.
    cfg.dna = { name: state.dnaName, sequence: state.seq, circular: state.circular,
                features: state.features };
  }
  return cfg;
}

function applyConfig(cfg) {
  state.lanes = (cfg.lanes || []).map((l) => ({ enzymeNames: [...l.enzymeNames] }));
  state.gelPct = cfg.gelPct || 1;
  // Configurations saved before pulsed-field existed have no gelMode; they were
  // all constant-field, so the default is the correct reading of their absence.
  state.gelMode = cfg.gelMode === "pfge" ? "pfge" : "agarose";
  state.pfgeRun = PFGE_RUNS[cfg.pfgeRun] ? cfg.pfgeRun : "medium";
  // A ladder is only valid in its own mode, and a config could name one from
  // the other; renderGelMode() re-derives it against the restored mode.
  state.ladderKey = LADDERS[cfg.ladderKey] ? cfg.ladderKey : "1kb";
  state.methylation = ["none", "dam_dcm", "cpg"].includes(cfg.methylation) ? cfg.methylation : "dam_dcm";
  renderGelMode();
  $("#methylation").value = state.methylation;
  const exp = Number(cfg.exposure);
  setExposure(exp > 0 ? Math.log2(exp) : 0, { redraw: false });
  const con = Number(cfg.contrast);
  setContrast(con > 0 ? con : 0.5, { redraw: false });
  if (cfg.dna?.sample && SAMPLES[cfg.dna.sample]) {
    const s = SAMPLES[cfg.dna.sample];
    loadDna(s.name, s.sequence, s.topology === "circular", cfg.dna.sample, s.features);
  } else if (cfg.dna?.sequence) {
    loadDna(cfg.dna.name || "imported sequence", cfg.dna.sequence,
            cfg.dna.circular !== false, null, cfg.dna.features || []);
  } else {
    renderAll();
  }
}



function renderLibrary() {
  const lib = readLibrary();
  const names = Object.keys(lib).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const wrap = $("#config-list");
  if (names.length === 0) {
    wrap.innerHTML = `<p class="hint">No saved configurations yet.</p>`;
    return;
  }
  wrap.innerHTML = names
    .map((n) => {
      const cfg = lib[n];
      const dnaLabel = cfg.dna?.sample
        ? SAMPLES[cfg.dna.sample]?.name || cfg.dna.sample
        : cfg.dna?.name || "custom DNA";
      return `
        <div class="config-row">
          <button class="config-load" data-name="${encodeURIComponent(n)}" title="Load this configuration">
            <span class="config-name">${n}</span>
            <span class="hint">${dnaLabel} · ${(cfg.lanes || []).length} lane${(cfg.lanes || []).length === 1 ? "" : "s"} · ${cfg.gelMode === "pfge" ? "PFGE" : `${cfg.gelPct} %`}</span>
          </button>
          <button class="btn ghost small config-del" data-name="${encodeURIComponent(n)}" title="Delete">✕</button>
        </div>`;
    })
    .join("");
  wrap.querySelectorAll(".config-load").forEach((b) =>
    b.addEventListener("click", () => {
      const name = decodeURIComponent(b.dataset.name);
      applyConfig(readLibrary()[name]);
      $("#config-name").value = name;
      setLibStatus(`Loaded “${name}”.`);
    })
  );
  // Two-click delete: first click arms the button, second click deletes.
  wrap.querySelectorAll(".config-del").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.armed) {
        const name = decodeURIComponent(b.dataset.name);
        const lib = readLibrary();
        delete lib[name];
        writeLibrary(lib);
        setLibStatus(`Deleted “${name}”.`);
      } else {
        b.dataset.armed = "1";
        b.textContent = "sure?";
        b.classList.add("danger");
        setTimeout(() => {
          delete b.dataset.armed;
          b.textContent = "✕";
          b.classList.remove("danger");
        }, 3000);
      }
    })
  );
}

let libStatusTimer;
function setLibStatus(msg) {
  $("#lib-status").textContent = msg;
  clearTimeout(libStatusTimer);
  libStatusTimer = setTimeout(() => ($("#lib-status").textContent = ""), 5000);
}

$("#save-config").addEventListener("click", () => {
  const name = $("#config-name").value.trim();
  if (!name) {
    setLibStatus("Give the configuration a name first.");
    return;
  }
  const lib = readLibrary();
  const existed = !!lib[name];
  lib[name] = currentConfig();
  writeLibrary(lib);
  setLibStatus(existed ? `Updated “${name}”.` : `Saved “${name}”.`);
});

$("#export-lib").addEventListener("click", () => {
  const blob = new Blob(
    [JSON.stringify({ app: "VIRGE", version: 1, configs: readLibrary() }, null, 2)],
    { type: "application/json" }
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "virge-library.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#import-lib").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const configs = data.configs && typeof data.configs === "object" ? data.configs : data;
    const entries = Object.entries(configs).filter(([, c]) => c && typeof c === "object" && c.lanes);
    if (entries.length === 0) throw new Error("no configurations found");
    const lib = readLibrary();
    let added = 0, replaced = 0;
    for (const [name, cfg] of entries) {
      lib[name] ? replaced++ : added++;
      lib[name] = cfg;
    }
    writeLibrary(lib);
    setLibStatus(`Imported ${entries.length} configuration${entries.length === 1 ? "" : "s"} (${added} new, ${replaced} replaced).`);
  } catch (err) {
    setLibStatus("Import failed: this doesn't look like a VIRGE library file (" + err.message + ").");
  }
});

// ---------- Gel + results ----------

/** The two field modes have disjoint ladders — a 1 kb ladder is meaningless on
 *  a pulsed-field gel and λ concatemers are meaningless on a constant-field one
 *  — so the ladder list is rebuilt whenever the mode changes, keeping the
 *  current choice if it is still valid and falling back to the first if not. */
function renderLadderOptions() {
  const options = laddersFor(state.gelMode);
  if (!options.some(([k]) => k === state.ladderKey)) state.ladderKey = options[0][0];
  $("#ladder-select").innerHTML = options
    .map(([k, label]) => `<option value="${k}">${escapeHtml(label)}</option>`).join("");
  $("#ladder-select").value = state.ladderKey;
}

function renderGelMode() {
  const pfge = state.gelMode === "pfge";
  $("#gel-mode").value = state.gelMode;
  $("#gel-pct-label").hidden = pfge;
  $("#pfge-run-label").hidden = !pfge;
  $("#gel-pct").value = String(state.gelPct);
  $("#pfge-run").value = state.pfgeRun;
  renderLadderOptions();
}

$("#pfge-run").innerHTML = Object.entries(PFGE_RUNS)
  .map(([k, r]) => `<option value="${k}">${escapeHtml(r.label)}</option>`).join("");

$("#gel-mode").addEventListener("change", (e) => {
  state.gelMode = e.target.value;
  renderGelMode();
  renderAll();
});
$("#pfge-run").addEventListener("change", (e) => { state.pfgeRun = e.target.value; renderAll(); });
$("#gel-pct").addEventListener("change", (e) => { state.gelPct = parseFloat(e.target.value); renderAll(); });
$("#ladder-select").addEventListener("change", (e) => { state.ladderKey = e.target.value; renderAll(); });

// The slider is in stops (powers of two) so each step is a perceptually even
// change, the way camera exposure compensation works.
function setExposure(stops, { redraw = true } = {}) {
  state.exposure = Math.pow(2, stops);
  $("#exposure").value = String(stops);
  $("#exposure-value").textContent = `${state.exposure.toFixed(state.exposure < 1 ? 2 : 1)}×`;
  if (redraw) renderGelOnly();
}
$("#exposure").addEventListener("input", (e) => setExposure(parseFloat(e.target.value)));
// Double-click either slider to return it to its default.
$("#exposure").addEventListener("dblclick", () => setExposure(0));

// Gamma read the way a darkroom would describe it, rather than as a bare number.
function contrastLabel(g) {
  if (g <= 0.34) return "very flat";
  if (g <= 0.44) return "flat";
  if (g < 0.58) return "normal";
  if (g < 0.85) return "punchy";
  if (g < 1.2) return "hard";
  return "very hard";
}

function setContrast(gamma, { redraw = true } = {}) {
  state.contrast = gamma;
  $("#contrast").value = String(gamma);
  $("#contrast-value").textContent = `${contrastLabel(gamma)} (γ ${gamma.toFixed(2)})`;
  if (redraw) renderGelOnly();
}
$("#contrast").addEventListener("input", (e) => setContrast(parseFloat(e.target.value)));
$("#contrast").addEventListener("dblclick", () => setContrast(0.5));

// Scrolling the panel with the pointer over a slider would otherwise nudge its
// value instead of scrolling. Swallow the wheel event and scroll the panel by
// hand, so passing over a slider never silently changes the gel.
for (const el of [$("#exposure"), $("#contrast")]) {
  el.addEventListener("wheel", (e) => {
    const panel = el.closest(".panel");
    if (!panel) return;
    e.preventDefault();
    panel.scrollTop += e.deltaY;
  }, { passive: false });
}
$("#download-gel").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = $("#gel-canvas").toDataURL("image/png");
  a.download = "virge-gel.png";
  a.click();
});

function computedLanes() {
  return state.lanes.map((lane) => {
    const enzymes = lane.enzymeNames.map(lookup).filter(Boolean);
    const d = digest(state.seq, enzymes, state.circular, { methylation: state.methylation });
    return {
      label: lane.enzymeNames.join(" + "),
      fragments: d.fragments,
      cuts: d.cuts,
      uncut: d.uncut && state.circular,
      blocked: d.blocked,
      warning: bufferWarning(enzymes),
    };
  });
}

function renderMeta() {
  const stats = sequenceStats(state.seq);
  const named = state.features.filter((f) => f.type === "CDS" || f.type === "gene").length;
  const bits = [
    `${stats.length.toLocaleString()} bp`,
    state.circular ? "circular" : "linear",
    `${stats.gc.toFixed(1)}% GC`,
  ];
  if (state.features.length) bits.push(`${state.features.length} features${named ? ` (${named} genes)` : ""}`);
  if (stats.ambiguous) bits.push(`${stats.ambiguous} ambiguous`);
  $("#dna-meta").innerHTML =
    `<strong>${escapeHtml(state.dnaName)}</strong><br><span class="hint">${bits.join(" · ")}</span>`;
}

// Genes and other named features a fragment carries — the practical question
// is "which band has my insert in it?"
function fragmentFeatures(frag) {
  if (!state.features.length) return [];
  const hits = featuresInRange(state.features, frag.start, frag.end, state.seq.length, state.circular);
  const named = hits.filter((f) => f.type === "CDS" || f.type === "gene" || f.type === "rep_origin");
  const seen = new Set();
  return (named.length ? named : hits)
    .filter((f) => !seen.has(f.label) && seen.add(f.label))
    .map((f) => f.label);
}

function renderTable(lanes) {
  const wrap = $("#lane-table");
  if (lanes.length === 0) {
    wrap.innerHTML = `<p class="hint">No lanes yet — select enzymes on the left and click <em>Add lane</em>.</p>`;
    return;
  }
  wrap.innerHTML = lanes
    .map((lane, i) => {
      // Beyond a few dozen fragments the list stops being readable (and the
      // per-fragment feature lookup gets expensive), so show the largest and
      // summarise the rest.
      const MAX_CHIPS = 40;
      const annotate = state.features.length > 0;
      const shown = lane.fragments.slice(0, MAX_CHIPS);
      const hidden = lane.fragments.length - shown.length;
      const chips = shown.map((f) => {
        const feats = annotate ? fragmentFeatures(f) : [];
        const title = feats.length ? ` title="carries ${escapeHtml(feats.join(", "))}"` : "";
        const tag = annotate && feats.length && lane.fragments.length <= 8
          ? `<span class="frag-feat">${escapeHtml(feats.slice(0, 3).join(", "))}${feats.length > 3 ? "…" : ""}</span>`
          : "";
        return `<span class="frag"${title}>${f.size.toLocaleString()}${tag}</span>`;
      }).join(" ");
      const more = hidden > 0
        ? ` <span class="hint">+${hidden.toLocaleString()} smaller, down to ${lane.fragments[lane.fragments.length - 1].size.toLocaleString()} bp</span>`
        : "";
      const frags = lane.uncut
        ? `<em>no cut sites — plasmid runs uncut (supercoiled/nicked)</em>`
        : chips + more;
      const notes = [];
      if (lane.blocked) notes.push(`<span class="blocked-note">${lane.blocked} site${lane.blocked === 1 ? "" : "s"} blocked by methylation</span>`);
      if (lane.warning) notes.push(`<span class="blocked-note">${lane.warning}</span>`);
      return `
        <div class="lane-row">
          <div class="lane-head">
            <span class="lane-num">Lane ${i + 2}</span>
            <strong>${lane.label}</strong>
            <span class="hint">${lane.cuts.length} cut${lane.cuts.length === 1 ? "" : "s"} · ${lane.fragments.length} fragment${lane.fragments.length === 1 ? "" : "s"}</span>
            <button class="btn ghost small remove-lane" data-i="${i}">✕</button>
          </div>
          <div class="frags">${frags} <span class="hint">bp</span></div>
          ${notes.length ? `<div class="lane-notes">${notes.join(" · ")}</div>` : ""}
        </div>`;
    })
    .join("");
  wrap.querySelectorAll(".remove-lane").forEach((b) =>
    b.addEventListener("click", () => {
      state.lanes.splice(parseInt(b.dataset.i, 10), 1);
      renderAll();
    })
  );
}

// The last computed digests, so redraws that only change how the gel is drawn
// (exposure, window resize) don't re-digest the sequence.
let lastLanes = [];

function renderGelOnly() {
  renderGel($("#gel-canvas"), lastLanes, {
    gelMode: state.gelMode,
    gelPct: state.gelPct,
    pfgeRun: state.pfgeRun,
    ladderKey: state.ladderKey,
    exposure: state.exposure,
    contrast: state.contrast,
  });
}

function renderAll() {
  renderDnaGroups();
  renderMeta();
  renderExciseTargets();
  renderEnzymes();
  lastLanes = computedLanes();
  renderGelOnly();
  renderTable(lastLanes);
}

// Start with the classic teaching digests of lambda DNA.
state.lanes = [
  { enzymeNames: ["HindIII"] },
  { enzymeNames: ["EcoRI"] },
  { enzymeNames: ["EcoRI", "HindIII"] },
  { enzymeNames: ["BamHI"] },
];
// ---------- Collapsible left-panel sections ----------
const SECTIONS_KEY = "virge-sections";

function initSections() {
  let open = {};
  try { open = JSON.parse(localStorage.getItem(SECTIONS_KEY)) || {}; } catch { /* defaults */ }

  for (const sec of document.querySelectorAll("details.section")) {
    if (typeof open[sec.id] === "boolean") sec.open = open[sec.id];
    sec.addEventListener("toggle", () => {
      const state = {};
      for (const s of document.querySelectorAll("details.section")) state[s.id] = s.open;
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(state));
      // The canvas is sized from its box, which changes when sections above it
      // collapse, so redraw once the layout has settled.
      requestAnimationFrame(renderGelOnly);
    });
  }

  // Controls that live in a section header act on their own, and must not
  // collapse the section they sit in.
  for (const el of document.querySelectorAll("details.section > summary button, details.section > summary input")) {
    el.addEventListener("click", (e) => e.stopPropagation());
  }
}

// ---------- Collapsible side panes ----------
const PANES_KEY = "virge-panes";

function initPanes() {
  const layout = document.getElementById("layout");
  const panes = {
    left: { el: document.getElementById("pane-left"), label: "configuration" },
    right: { el: document.getElementById("pane-right"), label: "assistant" },
  };

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PANES_KEY)) || {}; } catch { /* defaults */ }

  const apply = (side, collapsed) => {
    const { el, label } = panes[side];
    el.classList.toggle("collapsed", collapsed);
    layout.dataset[side] = collapsed ? "collapsed" : "expanded";
    const btn = el.querySelector(".pane-toggle");
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.title = `${collapsed ? "Show" : "Collapse"} the ${label} panel`;
  };

  for (const side of Object.keys(panes)) {
    apply(side, saved[side] === true);
    panes[side].el.querySelector(".pane-toggle").addEventListener("click", () => {
      const collapsed = !panes[side].el.classList.contains("collapsed");
      apply(side, collapsed);
      saved[side] = collapsed;
      localStorage.setItem(PANES_KEY, JSON.stringify(saved));
      // The centre column widens or narrows, and the canvas is sized from its
      // box, so redraw once the new grid tracks have settled.
      requestAnimationFrame(renderGelOnly);
    });
  }
}

// ---------- API surface the AI assistant's tools drive ----------
// Exposed deliberately rather than letting the assistant reach into internals,
// so every action it takes goes through the same paths the UI uses.
registerAssistantApp({
  getState: () => ({
    dnaName: state.dnaName, seq: state.seq, circular: state.circular,
    features: state.features, methylation: state.methylation,
    gelPct: state.gelPct, ladderKey: state.ladderKey,
    exposure: state.exposure, contrast: state.contrast,
  }),

  cutCount: (enzyme) => cutCountFor(enzyme),

  laneSummaries: () =>
    computedLanes().map((l) => ({
      enzymes: l.label,
      cuts: l.cuts.length,
      fragment_count: l.fragments.length,
      fragments: l.fragments.slice(0, 30).map((f) => f.size),
      uncut: l.uncut,
      blocked_sites: l.blocked,
      warning: l.warning || undefined,
    })),

  previewDigest: (enzymes) => {
    const d = digest(state.seq, enzymes, state.circular, { methylation: state.methylation });
    const annotate = state.features.length > 0;
    return {
      enzymes: enzymes.map((e) => e.name).join(" + "),
      cuts: d.cuts.length,
      uncut: d.uncut,
      fragment_count: d.fragments.length,
      fragments: d.fragments.slice(0, 40).map((f) =>
        annotate
          ? { size: f.size, carries: fragmentFeatures(f).slice(0, 6) }
          : { size: f.size }),
      truncated: d.fragments.length > 40,
      blocked_by_methylation: d.blocked,
      temperature_warning: bufferWarning(enzymes) || undefined,
    };
  },

  addLane: (names) => { state.lanes.push({ enzymeNames: [...names] }); renderAll(); },
  clearLanes: () => { state.lanes = []; renderAll(); },

  loadSample: async (key) => {
    const s = SAMPLES[key];
    openGroups.add(s.group);
    if (s.lazy) await loadLazySample(key, s);
    else loadDna(s.name, s.sequence, s.topology === "circular", key, s.features || []);
  },

  setGel: (opts) => {
    const applied = {};
    if (opts.agarose != null) { state.gelPct = opts.agarose; applied.agarose = opts.agarose; }
    // Mode before ladder: renderGelMode() re-derives the ladder against the new
    // mode, so setting the ladder first would have it overwritten.
    if (opts.field === "pfge" || opts.field === "agarose") {
      state.gelMode = opts.field; applied.field = opts.field;
    }
    if (opts.pfge_run && PFGE_RUNS[opts.pfge_run]) { state.pfgeRun = opts.pfge_run; applied.pfge_run = opts.pfge_run; }
    if (opts.ladder && LADDERS[opts.ladder]) {
      // A ladder implies its mode — asking for yeast chromosomes on a constant
      // field is a request for a pulsed-field gel, not an error.
      state.gelMode = LADDERS[opts.ladder].mode || "agarose";
      state.ladderKey = opts.ladder;
      applied.ladder = opts.ladder;
      applied.field = state.gelMode;
    }
    renderGelMode();
    if (opts.methylation) { state.methylation = opts.methylation; $("#methylation").value = opts.methylation; applied.methylation = opts.methylation; }
    if (opts.exposure_stops != null) { setExposure(Math.max(-2, Math.min(2.5, opts.exposure_stops)), { redraw: false }); applied.exposure_stops = opts.exposure_stops; }
    if (opts.contrast != null) { setContrast(Math.max(0.25, Math.min(1.6, opts.contrast)), { redraw: false }); applied.contrast = opts.contrast; }
    renderAll();
    return applied;
  },
});

setExposure(0, { redraw: false });
setContrast(0.5, { redraw: false });
initSections();
initPanes();
renderGelMode();   // ladder options are built from the mode, not hardcoded in HTML
initAssistant();
initSamples();
renderLibrary();

// Re-render the gel when the window (and thus the canvas box) changes size.
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderGelOnly, 100);
});
