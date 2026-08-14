// UI regression tests — run with: npm test
//
// Every check here corresponds to a bug that actually shipped, or nearly did.
// scripts/test.mjs covers the science; this covers the wiring between it and
// the page, which is where the reported bugs have all lived.
import { loadApp } from "./dom-harness.mjs";

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`));
};

const app = await loadApp();
const lanes = () => app.$$(".lane-row").length;
const laneNames = () => app.$$(".lane-row .lane-head strong").map((e) => e.textContent);
// Throws rather than returning undefined if the row is missing — a helper that
// quietly did nothing would make the assertions after it pass on an empty
// selection, which is exactly how the first run of this file reported a green
// "EcoRI does not warn".
const tick = (name) => {
  app.set("#enzyme-search", name, "input");
  return app.setChecked(`#enzyme-list input[value="${name}"]`, true);
};

// --- The app boots at all ---------------------------------------------------
check("starts with the four demo lanes", lanes(), 4);
check("gel draws its ladder caption", app.drawnText().includes("1 kb ladder"), true);

// --- `hidden` is honoured ----------------------------------------------------
// An author `display: flex` rule beat the UA stylesheet, so [hidden] elements
// stayed visible until a global override was added. The attribute is the
// contract the JS relies on.
//
// This has to run at boot. It sat at the end of the file and passed only
// because nothing before it had shown those elements — adding the excise tests,
// which legitimately reveal #suggest-note, turned it red and showed it had
// been asserting "currently hidden", not "starts hidden".
for (const id of ["#feature-warning", "#buffer-warning", "#ends-info", "#suggest-note"]) {
  check(`${id} starts hidden`, app.$(id).hasAttribute("hidden"), true);
}

// --- Pulsed field actually engages ------------------------------------------
// renderGel destructured `mode` while main.js passed `gelMode`, so switching
// the control changed nothing that was drawn. The sample lane still looked
// plausibly different, so a screenshot passed; only the ladder gave it away.
app.reset();
app.set("#gel-mode", "pfge");
const pfgeText = app.drawnText();
check("switching to pulsed field redraws as CHEF",
  pfgeText.some((t) => t.startsWith("CHEF pulsed-field")), true);
check("pulsed field swaps in a pulsed-field ladder",
  pfgeText.includes("λ ladder (PFG)"), true);
check("pulsed-field ladder labels reach megabases",
  pfgeText.some((t) => t.endsWith(" Mb")), true);
// A constant-field ladder must not survive the switch.
check("constant-field ladder is gone", pfgeText.includes("1 kb ladder"), false);
check("ladder options are rebuilt for the mode",
  app.$$("#ladder-select option").map((o) => o.getAttribute("value")), ["lambda-pfg", "yeast-chr"]);
check("agarose control hides, switch time shows",
  [app.$("#gel-pct-label").hasAttribute("hidden"), app.$("#pfge-run-label").hasAttribute("hidden")],
  [true, false]);

// The strongest signal, and the one the eye actually used: where the rungs land.
// A λ PFG marker is a concatemer series, so on a linear size axis its rungs are
// evenly spaced — that even spacing is the visible signature of pulsed-field
// mode. Under the wiring bug every rung collapsed onto the bottom edge, which a
// caption check alone would not have distinguished from a mislabelled gel.
const ladderYs = () => app.calls
  .filter((c) => c.op === "fillText" && /\d (bp|kb|Mb)$/.test(c.text))
  .map((c) => c.y).sort((a, b) => a - b);
const gaps = (ys) => ys.slice(1).map((y, i) => y - ys[i]);
// Fraction of *interior* gaps within 2% of the median.
//
// The first and last gap are dropped because the rungs at the ends are outside
// the resolving window and compressed deliberately — the λ marker's top rung is
// 1.02 Mb against the 10-60 s ceiling of 1 Mb, and its bottom rung is 97 kb
// against the floor of 100 kb. Excluding them states the claim exactly (spacing
// is constant inside the window) instead of loosening a threshold until the
// compression zones squeeze under it.
const evenFraction = (ys) => {
  const g = gaps(ys).slice(1, -1).filter((x) => x > 0.5).sort((a, b) => a - b);
  if (g.length < 3) return 0;
  const median = g[Math.floor(g.length / 2)];
  return g.filter((x) => Math.abs(x - median) / median <= 0.02).length / g.length;
};
const pfgeYs = ladderYs();
check("pulsed-field draws many ladder rungs", pfgeYs.length >= 15, true);
check("rungs are spread down the gel, not stacked on one edge",
  pfgeYs[pfgeYs.length - 1] - pfgeYs[0] > 300, true);
check("λ concatemers are evenly spaced on a linear size axis",
  evenFraction(pfgeYs), 1);

app.reset();
app.set("#gel-mode", "agarose");
check("switching back restores a constant-field gel",
  app.drawnText().some((t) => t.endsWith("% agarose · constant field")), true);
check("and a constant-field ladder", app.drawnText().includes("1 kb ladder"), true);
// The same measurement on a log axis must come out clearly uneven, or the
// evenness check above proves nothing about the mode.
check("constant-field rungs are unevenly spaced (log axis)", evenFraction(ladderYs()) < 0.5, true);

// --- Suggest replaces the lanes ---------------------------------------------
// It used to append, so a second click stacked six lanes — the second three
// being the digests the scorer had already rejected.
app.click("#suggest-digests");
const firstPicks = laneNames();
check("Suggest replaces rather than appends", lanes(), 3);
app.click("#suggest-digests");
check("clicking Suggest twice is idempotent", laneNames(), firstPicks);
check("a second click still leaves three lanes", lanes(), 3);

// --- Lane captions do not collide -------------------------------------------
// The harness's measureText is a stub (6px per character), so these assert the
// layout *rule*, not the exact metrics: captions must never overlap a same-row
// neighbour, whatever the lane width.
const captions = () => {
  const ys = new Set(app.calls.filter((c) => c.op === "fillText" && c.y < 32).map((c) => c.y));
  const rows = [...ys].map((y) => app.calls
    .filter((c) => c.op === "fillText" && c.y === y)
    .map((c) => ({ x: c.x, w: c.text.length * 6 }))
    .sort((a, b) => a.x - b.x));
  return rows;
};
const overlaps = (rows) => rows.some((row) =>
  row.slice(1).some((c, i) => row[i].x + row[i].w / 2 > c.x - c.w / 2));

// Enough lanes that the captions are genuinely wider than their lane. At the
// harness's 760px canvas, eight lanes give laneW ≈ 81px against a caption like
// "EcoRI + HindIII" at ~90px. With four lanes everything fits regardless, which
// is how the first version of this check passed against the old code too.
app.reset();
app.click("#clear-lanes");
const pairs = [["EcoRI", "HindIII"], ["BamHI", "PstI"], ["SalI", "XbaI"], ["KpnI", "SacI"],
               ["SphI", "XhoI"], ["ClaI", "NcoI"], ["NdeI", "SpeI"], ["SmaI", "NotI"]];
for (const pair of pairs) {
  for (const n of pair) tick(n);
  app.click("#add-lane");
}
check("eight multi-enzyme lanes added", lanes(), pairs.length);
app.reset();
app.set("#gel-pct", "1");           // force a redraw with the long captions
const rows = captions();
check("a caption is wider than its lane here",
  rows.flat().some((c) => c.w > (760 - 110) / (pairs.length + 1) - 6), true);
check("long captions never overlap a same-row neighbour", overlaps(rows), false);
check("long captions are staggered onto two rows", rows.length >= 2, true);
app.click("#clear-lanes");

// --- Clear lanes ------------------------------------------------------------
app.click("#clear-lanes");
check("Clear lanes empties the table", lanes(), 0);

// --- Enzyme selection survives its own re-render -----------------------------
// renderEnzymes() rebuilds the list with innerHTML, which destroyed checkbox
// state — that is why the Clear button appeared not to work.
tick("EcoRV");
check("ticking an enzyme arms the Add button", app.$("#add-lane").disabled, false);
app.set("#enzyme-search", "", "input");   // forces a full re-render
check("selection survives a re-render", app.$("#add-lane").textContent.includes("EcoRV"), true);
app.click("#clear-sel");
check("Clear selection disarms Add", app.$("#add-lane").disabled, true);
check("Clear selection empties the label",
  app.$("#add-lane").textContent.trim(), "Add lane with selection →");

// --- Cuts inside annotated features -----------------------------------------
// Opposite answers on the same shape of input: EcoRV's single cut is inside
// tet, EcoRI's single cut is not inside anything.
tick("EcoRV");
check("EcoRV warns about cutting tet",
  [app.$("#feature-warning").hasAttribute("hidden"), app.$("#feature-warning").textContent],
  [false, "1 cut lands inside 1 annotated feature: tet."]);
app.click("#clear-sel");
check("clearing the selection clears the warning",
  app.$("#feature-warning").hasAttribute("hidden"), true);
tick("EcoRI");
check("EcoRI does not warn", app.$("#feature-warning").hasAttribute("hidden"), true);
app.click("#clear-sel");

// --- Searching the catalog by name -------------------------------------------
const dnaNames = () => app.$$(".dna-item .dna-name").map((e) => e.textContent);
const searchNote = () => (app.$("#dna-search-note").hasAttribute("hidden")
  ? null : app.$("#dna-search-note").textContent);

const allNames = dnaNames();
check("the unfiltered list shows every sample", allNames.length, 44);

app.set("#dna-search", "chickenpox", "input");
check("a common name finds the sample", dnaNames(), ["Varicella-zoster virus"]);
check("matching groups are opened, or the hit stays hidden",
  app.$$(".dna-groups details").every((d) => d.hasAttribute("open") || !d.querySelector(".dna-item")), true);

app.set("#dna-search", "λ", "input");
check("a symbol alias works", dnaNames().includes("Lambda phage"), true);

// The point of the curated layer: a dead end becomes an explanation.
app.set("#dna-search", "COVID 19", "input");
check("COVID 19 matches no sample", dnaNames(), []);
check("but the panel explains why", /RNA virus/.test(searchNote() || ""), true);
check("and names it", /SARS-CoV-2/.test(searchNote() || ""), true);

app.set("#dna-search", "pET-28a", "input");
check("pET-28a explains where to get it", /Addgene/.test(searchNote() || ""), true);

app.set("#dna-search", "zzzznothing", "input");
check("an ordinary miss says so without a lecture", searchNote(), null);
check("and offers the fetch route",
  /accession/.test(app.$("#dna-groups").textContent), true);

app.set("#dna-search", "", "input");
check("clearing the box restores the full list", dnaNames().length, allNames.length);
check("and clears the note", searchNote(), null);

// --- Cut a feature out -------------------------------------------------------
check("the excise row is shown on annotated DNA", app.$("#excise-row").hasAttribute("hidden"), false);
const targets = app.$$("#excise-feature option").map((o) => o.textContent);
check("targets are named genes, not every annotation",
  targets.map((t) => t.split(" · ")[0]), ["tet", "ROP protein", "bla"]);
// pBR322 annotates rep_origin as a single base — real data, but nothing you can
// cut out, and it appeared in the picker until a minimum span was required.
check("a 1 bp feature is not offered as excisable",
  targets.some((t) => t.startsWith("rep_origin")), false);

app.set("#excise-feature", String(targets.findIndex((t) => t.startsWith("tet"))));
app.click("#excise-go");
check("excising tet replaces the lanes with the options", lanes(), 3);
check("the best option is named in the note",
  app.$("#suggest-note").textContent,
  "AvaI + HindIII cuts tet out in a 1,396 bp fragment — 56 bp upstream and 149 bp downstream come with it.");
check("the note is visible", app.$("#suggest-note").hasAttribute("hidden"), false);
check("the first lane is the best option",
  laneNames()[0], "AvaI + HindIII");
app.click("#clear-lanes");

// --- Import status belongs to the loaded sequence ----------------------------
// It used to persist, so a receipt for the previous sequence sat under the new
// one's own line, naming a different molecule.
app.$("#import-status").textContent = "Loaded Yeast chromosome I · 230,218 bp";
const dnaButtons = app.$$(".dna-item");
const pUC19 = dnaButtons.find((b) => b.textContent.includes("pUC19"));
app.click(pUC19);
check("loading a sequence clears the previous receipt", app.$("#import-status").textContent, "");
check("and the metadata line names the new one",
  app.$("#dna-meta").textContent.includes("pUC19"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
