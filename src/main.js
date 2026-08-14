import { SAMPLES, GROUPS } from "./data/samples.js";
import { ENZYMES, lookup, endType, siteWithCut, bufferWarning,
         overhangSignature, compatibleEnds } from "./enzymes.js";
import { digest, findCuts } from "./digest.js";
import { suggestDigests } from "./suggest.js";
import { renderGel } from "./gel.js";
import { parseAny, sequenceStats, featuresInRange } from "./genbank.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  dnaKey: null,     // sample key, or null when a custom sequence is loaded
  dnaName: "",
  seq: "",
  circular: true,
  features: [],     // annotations from a GenBank record, when available
  lanes: [],        // [{ enzymeNames: [...] }]
  selected: new Set(), // enzyme names ticked but not yet added as a lane
  gelPct: 1,
  ladderKey: "1kb",
  exposure: 1,      // gel-doc style exposure multiplier
  contrast: 0.5,    // gamma of the intensity transfer curve
  methylation: "dam_dcm",
  search: "",
  tier: 2,
  cutFilter: "any",  // "any" | "cutters" | "unique"
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
  const stats = sequenceStats(rec.sequence);
  loadDna(stored, rec.sequence, circular, `user:${stored}`, rec.features || []);
  setImportStatus(
    `Loaded ${stats.length.toLocaleString()} bp · ${stats.gc.toFixed(1)}% GC` +
    (rec.features?.length ? ` · ${rec.features.length} features` : " · no annotations") +
    (stats.ambiguous ? ` · ${stats.ambiguous} ambiguous bases` : "") +
    (usable.length > 1 ? ` — first of ${usable.length} records; the rest are saved too.` : "")
  );
  // Multi-record files: keep the others so they show up in Saved sequences.
  for (const extra of usable.slice(1)) {
    saveUserSeq({
      name: extra.name, accession: extra.accession || "", sequence: extra.sequence,
      features: extra.features || [], topology: (extra.circular ?? false) ? "circular" : "linear",
    });
  }
  renderDnaGroups();
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
    loadDna(s.name, rec.sequence, s.topology === "circular", key, rec.features || []);
    setImportStatus(`Loaded ${s.name} · ${rec.sequence.length.toLocaleString()} bp` +
      (rec.features?.length ? ` · ${rec.features.length} features` : ""));
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
  const groups = [
    ...GROUPS.map((g) => ({
      title: g,
      items: Object.entries(SAMPLES)
        .filter(([, s]) => s.group === g)
        .sort(([, a], [, b]) => a.name.localeCompare(b.name)),
      removable: false,
    })),
  ];
  const userItems = Object.entries(userSeqs)
    .map(([name, s]) => [`user:${name}`, { ...s, length: s.sequence.length }])
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
  if (userItems.length) {
    groups.unshift({ title: "Your sequences", items: userItems, removable: true });
  }

  for (const { title, items, removable } of groups) {
    const det = document.createElement("details");
    det.open = openGroups.has(title);
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
  const existing = state.lanes.map((l) => [...l.enzymeNames].sort().join("+"));
  const picks = suggestDigests(state.seq, state.circular, { count: 3, existing, methylation: state.methylation });
  if (picks.length === 0) return;
  for (const names of picks) state.lanes.push({ enzymeNames: names });
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
    gelPct: state.gelPct,
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
  state.ladderKey = LADDERS_KEYS.includes(cfg.ladderKey) ? cfg.ladderKey : "1kb";
  state.methylation = ["none", "dam_dcm", "cpg"].includes(cfg.methylation) ? cfg.methylation : "dam_dcm";
  $("#gel-pct").value = String(state.gelPct);
  $("#ladder-select").value = state.ladderKey;
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

const LADDERS_KEYS = ["1kb", "100bp"];

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
            <span class="hint">${dnaLabel} · ${(cfg.lanes || []).length} lane${(cfg.lanes || []).length === 1 ? "" : "s"} · ${cfg.gelPct} %</span>
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
    gelPct: state.gelPct,
    ladderKey: state.ladderKey,
    exposure: state.exposure,
    contrast: state.contrast,
  });
}

function renderAll() {
  renderDnaGroups();
  renderMeta();
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

setExposure(0, { redraw: false });
setContrast(0.5, { redraw: false });
initSections();
initSamples();
renderLibrary();

// Re-render the gel when the window (and thus the canvas box) changes size.
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderGelOnly, 100);
});
