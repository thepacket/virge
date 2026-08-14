// Regression tests — run with: npm test
// Expected values are published restriction maps, not outputs of this code.
import { SAMPLES } from "../src/data/samples.js";
import { lookup, ENZYMES, overhangSignature, compatibleEnds, bufferWarning } from "../src/enzymes.js";
import { digest, findSites, findCuts } from "../src/digest.js";
import { suggestDigests, excisionOptions } from "../src/suggest.js";
import { parseAny, sequenceStats, ParseError, featuresCutBy } from "../src/genbank.js";
import { LADDERS, PFGE_RUNS, laddersFor, sizeLabel, sizeWindow } from "../src/gel.js";
import { searchSamples, searchNcbi, EXCLUDED } from "../src/dna-search.js";
import { renderMarkdown, splitMath, configureSanitizer } from "../src/markdown.js";
import { JSDOM } from "jsdom";

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}` +
    (ok ? "" : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`));
};

const puc = SAMPLES.pUC19.sequence, lam = SAMPLES.lambda.sequence;
const sizes = (d) => (d.uncut ? "uncut" : d.fragments.map((x) => x.size).join(", "));

// --- Published fragment maps ------------------------------------------------
check("λ / HindIII", sizes(digest(lam, [lookup("HindIII")], false)),
  "23130, 9416, 6682, 4361, 2322, 2027, 564");
check("λ / EcoRI", sizes(digest(lam, [lookup("EcoRI")], false)),
  "21226, 7421, 5804, 5643, 4878, 3530");
check("pUC19 / PvuII", sizes(digest(puc, [lookup("PvuII")], true)), "2364, 322");
check("pUC19 / EcoRI + PstI (43 bp polylinker)",
  sizes(digest(puc, [lookup("EcoRI"), lookup("PstI")], true)), "2643, 43");

// --- Type IIS: cut coordinates outside the recognition site -----------------
const iis = { BsaI: [7, 11], BsmBI: [7, 11], BbsI: [8, 12], SapI: [8, 11],
              FokI: [14, 18], MmeI: [26, 24] };
for (const [name, want] of Object.entries(iis)) {
  const e = lookup(name);
  check(`${name} cut coords`, [e.cutTop, e.cutBottom], want);
}
check("BsaI overhang is programmable", overhangSignature(lookup("BsaI")).kind, "variable");

// --- Both-strand search: a non-palindromic site must be found either way ----
// Same site written forwards and as its reverse complement; both must be seen,
// and the − strand hit must cut upstream of the site (BsaI reaches outwards).
const plus = "AAAAAAGGTCTCAAAAAAAAAA";
const minus = "AAAAAAAAAATTTTTGAGACCAAAAAA"; // GAGACC = revcomp(GGTCTC)
const onPlus = findSites(plus, lookup("BsaI"), false);
const onMinus = findSites(minus, lookup("BsaI"), false);
check("BsaI found on + strand", [onPlus.length, onPlus[0]?.strand], [1, 1]);
check("BsaI found on − strand", [onMinus.length, onMinus[0]?.strand], [1, -1]);
check("− strand cut lands upstream of the site",
  onMinus[0].topCut < onMinus[0].start, true);

// --- Methylation: the GATC trio --------------------------------------------
const cuts = (n, m) => digest(puc, [lookup(n)], true, { methylation: m }).cuts.length;
check("MboI blocked on dam+", cuts("MboI", "dam_dcm"), 0);
check("MboI cuts unmethylated", cuts("MboI", "none"), 15);
check("Sau3AI ignores Dam", [cuts("Sau3AI", "dam_dcm"), cuts("Sau3AI", "none")], [15, 15]);
check("DpnI requires Dam", [cuts("DpnI", "dam_dcm"), cuts("DpnI", "none")], [15, 0]);

// Dam blocking is context-dependent, not blanket
const blocked = (seq, n) => findSites(seq, lookup(n), false, "dam_dcm").map((s) => s.blocked);
check("XbaI blocked in TCTAGATC", blocked("GGGGGGGGGGTCTAGATCGGGGGGGGGG", "XbaI"), [true]);
check("XbaI cuts in TCTAGAGG", blocked("GGGGGGGGGGTCTAGAGGGGGGGGGGGG", "XbaI"), [false]);
check("BamHI unaffected by Dam", blocked("GGGGGGGGGGGATCCGGGGGGGG", "BamHI"), [false]);

// CpG: HpaII is blocked by CpG methylation, its isoschizomer MspI is not.
// Both recognize CCGG, so this isolates the methylation logic alone.
const cpgSeq = "AAAACCGGAAAACCGGAAAA";
const cpgBlocked = (n) => findSites(cpgSeq, lookup(n), false, "cpg").map((s) => s.blocked);
check("HpaII blocked by CpG", cpgBlocked("HpaII"), [true, true]);
check("MspI ignores CpG", cpgBlocked("MspI"), [false, false]);
check("HpaII cuts when unmethylated",
  findSites(cpgSeq, lookup("HpaII"), false, "none").map((s) => s.blocked), [false, false]);

// --- Compatible cohesive ends ----------------------------------------------
const gatc = compatibleEnds(lookup("BamHI"));
check("BamHI GATC family", ["BglII", "BclI", "Sau3AI", "MboI", "DpnII", "BstYI"].every((n) => gatc.includes(n)), true);
check("PstI 3′ TGCA family", compatibleEnds(lookup("PstI")).sort(), ["NsiI", "SbfI"]);
check("XbaI CTAG family", compatibleEnds(lookup("XbaI")).sort(), ["AvrII", "NheI", "SpeI"]);

// --- Sequence file parsing --------------------------------------------------
const GB = `LOCUS       pTEST                   60 bp    DNA     circular SYN 01-JAN-2026
DEFINITION  Test construct.
FEATURES             Location/Qualifiers
     source          1..60
                     /organism="synthetic"
     CDS             10..30
                     /label="myGene"
     promoter        complement(40..55)
                     /gene="pTest"
ORIGIN
        1 gaattcaaaa tgaaaaaaaa aaaaaaaaaa ggatccaaaa aaaaaaaaaa aaaactgcag
//`;
const [gbRec] = parseAny(GB);
check("GenBank: topology from LOCUS", gbRec.circular, true);
check("GenBank: definition as name", gbRec.name, "Test construct");
check("GenBank: sequence length", gbRec.sequence.length, 60);
check("GenBank: source feature skipped", gbRec.features.map((f) => f.label), ["myGene", "pTest"]);
check("GenBank: 1-based location → 0-based half-open",
  [gbRec.features[0].start, gbRec.features[0].end], [9, 30]);
check("GenBank: complement strand", gbRec.features[1].strand, -1);

check("FASTA: multi-record", parseAny(">a x\nACGT\n>b y\nTTTTGGGG").map((r) => r.sequence),
  ["ACGT", "TTTTGGGG"]);
check("bare sequence accepted", parseAny("acgtacgtacgt")[0].sequence, "ACGTACGTACGT");

// A GenBank file we cannot read must raise, never fall back to scraping letters
// out of its prose — that silently produced a wrong 7,195 bp "sequence" once.
const CON = `LOCUS       NC_TEST                 9609 bp    DNA     circular CON 01-JAN-2026
DEFINITION  Contig record with no sequence.
FEATURES             Location/Qualifiers
     CDS             1..100
                     /label="istA"
CONTIG      join(AE017046.1:1..9609)
//`;
const threw = (fn) => { try { fn(); return false; } catch (e) { return e instanceof ParseError; } };
check("CON record raises rather than scraping", threw(() => parseAny(CON)), true);
check("non-DNA text raises", threw(() => parseAny("This is a report about safety procedures.")), true);

check("stats: GC and ambiguous", (({ gc, ambiguous }) => [Math.round(gc), ambiguous])
  (sequenceStats("GGCCAATTNN")), [40, 2]);

// --- Sample catalog ---------------------------------------------------------
const samples = Object.entries(SAMPLES);
check("bundled samples carry their sequence",
  samples.filter(([, s]) => !s.lazy).every(([, s]) => s.sequence?.length === s.length), true);
check("on-demand samples carry metadata but no sequence",
  samples.filter(([, s]) => s.lazy).every(([, s]) => !s.sequence && s.accession && s.length > 0 && s.fetchAs), true);
check("every sample has a topology",
  samples.every(([, s]) => s.topology === "circular" || s.topology === "linear"), true);
// A restriction digest needs a DNA duplex, so nothing in the catalog may be RNA
// or an un-labelled single strand. SARS-CoV-2 (NC_045512, ss-RNA by its own
// LOCUS line) was offered here and drew a gel as confidently as a plasmid.
// scripts/build-samples.mjs enforces this at build time against NCBI; this
// pins the shipped result so a hand-edit of the generated file cannot undo it.
check("no RNA genome is offered as a sample",
  samples.some(([, s]) => /SARS|coronavirus|influenza|\bRNA\b/i.test(s.name + " " + (s.description || ""))), false);
// phiX174 and M13 are ss-DNA virions; only their replicative form is a duplex.
check("single-stranded genomes are named for their replicative form",
  ["phiX174", "M13", "M13mp18"].map((k) => /\bRF\b/.test(SAMPLES[k].name)), [true, true, true]);

// Plasmids deposited as linear records must be corrected, or a digest loses the
// junction fragment.
check("circular plasmids corrected",
  ["pACYC177", "RK2", "M13mp18"].map((k) => SAMPLES[k].topology), ["circular", "circular", "circular"]);
check("linear genomes stay linear",
  ["lambda", "T7", "T4", "yeastChrI", "HSV1"].map((k) => SAMPLES[k].topology),
  ["linear", "linear", "linear", "linear", "linear"]);

// --- Suggestions ------------------------------------------------------------
// These pin the properties that made the first version toy-like: it ignored
// annotations, proposed digests that can't share a tube, offered isoschizomers
// as distinct options, and pinned every result to the top of its band range.
const PROTECTED = new Set(["CDS", "gene", "rep_origin"]);
const suggestFor = (key, purpose) => {
  const s = SAMPLES[key];
  return suggestDigests(s.sequence, s.topology === "circular", {
    count: 3, methylation: "dam_dcm", features: s.features || [], purpose,
  });
};
const digestOf = (key, names) => {
  const s = SAMPLES[key];
  return digest(s.sequence, names.map(lookup), s.topology === "circular", { methylation: "dam_dcm" });
};

// Never propose an experiment the app's own check says can't be run in one tube.
const allPicks = ["pUC19", "pBR322", "pEGFP_N1", "lambda", "T7", "phiX174", "SV40"]
  .flatMap((k) => ["diagnostic", "cloning", "fingerprint"].map((p) => suggestFor(k, p)))
  .flat();
check("no suggestion has a temperature clash",
  allPicks.filter((names) => bufferWarning(names.map(lookup))).length, 0);

// Band count must track the purpose, not sit at the top of the allowed range.
const bandsFor = (purpose) => ["pUC19", "pBR322", "pEGFP_N1", "SV40"]
  .flatMap((k) => suggestFor(k, purpose).map((n) => digestOf(k, n).fragments.length));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
check("cloning aims at ~2 bands", mean(bandsFor("cloning")) < 3.5, true);
check("diagnostic aims at ~5 bands",
  (() => { const m = mean(bandsFor("diagnostic")); return m > 3 && m < 8; })(), true);
check("fingerprint aims high", mean(bandsFor("fingerprint")) > 7, true);

// Cloning must prefer cuts that spare annotated genes where that's possible.
const cloningCutsInGenes = (key) => {
  const s = SAMPLES[key];
  const genes = (s.features || []).filter((f) => PROTECTED.has(f.type));
  return suggestFor(key, "cloning").flatMap((names) =>
    digestOf(key, names).cuts.filter((c) =>
      genes.some((g) => g.segments.some((sg) => c >= sg.start && c < sg.end))));
};
check("cloning spares genes on pBR322", cloningCutsInGenes("pBR322").length, 0);
check("cloning spares genes on pEGFP-N1", cloningCutsInGenes("pEGFP_N1").length, 0);

// Isoschizomers cut identically, so they must not appear as separate options.
const sigOf = (key, names) => digestOf(key, names).cuts.join(",");
for (const purpose of ["diagnostic", "fingerprint"]) {
  const sigs = suggestFor("pUC19", purpose).map((n) => sigOf("pUC19", n));
  check(`no duplicate digests among ${purpose} picks`, sigs.length, new Set(sigs).size);
}

// No enzyme should anchor every suggestion.
const reuse = (key, purpose) => {
  const counts = {};
  suggestFor(key, purpose).flat().forEach((n) => (counts[n] = (counts[n] || 0) + 1));
  return Math.max(0, ...Object.values(counts));
};
check("no enzyme appears in all three picks", reuse("pUC19", "cloning") <= 2, true);

// --- Catalog integrity ------------------------------------------------------
check("every enzyme has cut coordinates",
  ENZYMES.every((e) => Number.isInteger(e.cutTop) && Number.isInteger(e.cutBottom)), true);
check("every enzyme has a valid site",
  ENZYMES.every((e) => /^[ACGTRYSWKMBDHVN]+$/.test(e.site)), true);

// --- Cuts landing inside annotated features ---------------------------------
// One definition, used by both Suggest's scoring and the enzyme panel's warning,
// so the automated and the hand-picked path cannot disagree about what counts.
const pbr = SAMPLES.pBR322;
const cutsOf = (name) => findCuts(pbr.sequence, lookup(name), true, "dam_dcm");
const hitLabels = (name) => featuresCutBy(cutsOf(name), pbr.features).map((h) => h.label).sort();

// EcoRV cuts pBR322 once, inside the tet resistance gene — the textbook reason
// EcoRV is the classic insertional-inactivation site on this plasmid.
check("EcoRV cuts pBR322 once", cutsOf("EcoRV").length, 1);
check("EcoRV's cut lands inside tet", hitLabels("EcoRV").includes("tet"), true);

// EcoRI cuts pBR322 once too, but at position 4359 — outside every gene, which
// is why it is the standard cloning site here. Same shape of input, opposite
// answer: a warning that fires for both would be worthless.
check("EcoRI cuts pBR322 once", cutsOf("EcoRI").length, 1);
check("EcoRI's cut hits no annotated feature", hitLabels("EcoRI"), []);

// pBR322 annotates tet as both a `gene` and a `CDS` over the same span, so one
// EcoRV cut matches two features. Anything reporting a count has to say one cut
// and one gene, not two of each.
const ecorvHits = featuresCutBy(cutsOf("EcoRV"), pbr.features);
check("one EcoRV cut matches two tet annotations", ecorvHits.length, 2);
check("distinct labels collapse to one gene",
  new Set(ecorvHits.map((h) => h.label)).size, 1);
check("distinct cut positions collapse to one cut",
  new Set(ecorvHits.flatMap((h) => h.cuts)).size, 1);

check("no features means no hits", featuresCutBy([100, 200], []), []);
check("no cuts means no hits", featuresCutBy([], pbr.features), []);

// Only CDS / gene / rep_origin are protected; a source or misc feature is not
// something a cut through destroys.
check("unprotected feature types are ignored",
  featuresCutBy([50], [{ type: "misc_feature", label: "x", segments: [{ start: 0, end: 100 }] }]), []);
check("a CDS is protected",
  featuresCutBy([50], [{ type: "CDS", label: "y", segments: [{ start: 0, end: 100 }] }])
    .map((h) => h.label), ["y"]);

// A cut inside two overlapping genes is still one bad cut, or the fraction
// Suggest scores on could exceed 1.
const overlapping = [
  { type: "CDS", label: "a", segments: [{ start: 0, end: 100 }] },
  { type: "gene", label: "b", segments: [{ start: 40, end: 120 }] },
];
check("overlapping features both reported", featuresCutBy([50], overlapping).map((h) => h.label), ["a", "b"]);
check("but the cut is counted once",
  new Set(featuresCutBy([50], overlapping).flatMap((h) => h.cuts)).size, 1);

// --- Assistant markdown and LaTeX -------------------------------------------
{
  // jsdom, not linkedom: DOMPurify needs document.implementation and
  // NodeFilter, which linkedom does not provide. Handed something unusable it
  // returns a passthrough rather than failing, so a half-shimmed DOM would
  // report a green sanitiser that does nothing.
  const { window } = new JSDOM("<!doctype html><html><body></body></html>");
  check("the test DOM actually supports sanitising", configureSanitizer(window), true);

  // Math comes out before markdown runs, or `*` and `_` inside a formula are
  // eaten as emphasis.
  const m = splitMath("size is $a_i \\times b^2$ and $$\\frac{n}{2}$$ done");
  check("math is extracted, not left inline", /\$/.test(m.text), false);
  check("both expressions captured", m.math.map((x) => x.display), [true, false]);
  check("display math keeps its LaTeX", m.math[0].tex, "\\frac{n}{2}");

  // Currency must not be mistaken for math, or ordinary prose breaks.
  check("prices are not formulas", splitMath("costs $5 to $10 per reaction").math, []);
  check("a lone dollar is left alone", splitMath("$ is not math").math, []);

  const md = renderMarkdown("**bold** and `code`\n\n- one\n- two");
  check("markdown renders", [/<strong>bold<\/strong>/.test(md), /<code>code<\/code>/.test(md),
                             /<li>one<\/li>/.test(md)], [true, true, true]);

  const tex = renderMarkdown("The rate is $E = mc^2$.");
  check("LaTeX renders to MathML", /<math/.test(tex), true);
  // KaTeX's default HTML output writes inline style attributes, which VIRGE's
  // CSP (style-src 'self') blocks. MathML output writes none — that is the
  // whole reason for the output setting, so it is pinned.
  check("no inline styles reach the page", /style=/.test(tex), false);
  // KaTeX wraps its output in <semantics> with an <annotation> holding the
  // source TeX. DOMPurify drops those tags but keeps their text, so the raw
  // LaTeX printed as a second line under every rendered equation.
  const disp = renderMarkdown("$$\\frac{\\log_{10}(S)}{2}$$");
  check("the source TeX is not echoed beside the rendered maths",
    /\\frac|\\log/.test(disp), false);
  check("but the equation is still there", /<math/.test(disp), true);

  check("a broken formula degrades to its source, not to nothing",
    /\\frac\{/.test(renderMarkdown("$\\frac{$")) || /<code>/.test(renderMarkdown("$\\frac{$")), true);

  // The reply is not trusted: the model has just read a GenBank file the user
  // dropped in, whose labels and definitions are someone else's text.
  const attacks = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<a href=\"javascript:alert(1)\">click</a>",
    "<iframe src=\"https://evil.example\"></iframe>",
    "<div style=\"position:fixed;inset:0\">overlay</div>",
    "<form action=\"https://evil.example\"><input name=key></form>",
  ];
  for (const a of attacks) {
    const out = renderMarkdown(a);
    check(`sanitised: ${a.slice(0, 28)}`,
      /<script|onerror|javascript:|<iframe|<form|<input|style=/i.test(out), false);
  }
  // Sanitising must not be so aggressive that ordinary links stop working.
  check("plain links survive", /href="https:\/\/example\.com"/.test(
    renderMarkdown("[x](https://example.com)")), true);
}

// --- Finding DNA by name ----------------------------------------------------
const find = (q) => searchSamples(q, SAMPLES);
const found = (q) => find(q).keys;

// An empty query is "no filter", which is not the same as "no matches" — the UI
// has to tell those apart or an empty box hides the whole catalog.
check("an empty query does not filter", find("").keys, null);
check("a query with no match returns an empty list, not null", found("zzzznothing"), []);

check("common names find their sample", [
  found("lambda").includes("lambda"),
  found("epstein barr").includes("EBV"),
  found("chickenpox").includes("VZV"),
  found("mtDNA").includes("humanMito"),
  found("green fluorescent protein").includes("pEGFP_N1"),
  found("2-micron").includes("twoMicron"),
], [true, true, true, true, true, true]);

// Punctuation and spacing people actually type.
check("spelling variants normalise", [
  found("pUC 19").includes("pUC19"),
  found("phi x 174").includes("phiX174"),
  found("E. coli").includes("ecoliK12"),
  found("hsv-1").includes("HSV1"),
], [true, true, true, true]);

// Multi-word queries where no single field contains the whole phrase.
check("all-words fallback finds yeast chromosome I", found("yeast chromosome").includes("yeastChrI"), true);

// The point of the curated layer: absence gets explained, not silently returned
// as zero results. NCBI's own answer to "COVID 19" is 185,232 records led by
// Klebsiella plasmids, which is why this is a hand-written map.
const covid = find("COVID 19");
check("COVID 19 finds nothing in the catalog", covid.keys, []);
check("but says why", covid.note?.title, "SARS-CoV-2");
check("and names the actual reason", /RNA/.test(covid.note.reason), true);
for (const q of ["covid", "SARS-CoV-2", "coronavirus", "sars cov 2"]) {
  check(`"${q}" is explained`, find(q).note?.title, "SARS-CoV-2");
}
check("pET-28a is explained as an Addgene vector",
  find("pET-28a").note?.title, "Commercial and Addgene vectors");
check("and points at file import", /Addgene|drop it/.test(find("pET28a").note.reason), true);
check("influenza is explained as RNA", find("influenza").note?.title, "RNA viruses");

// A note may accompany real matches: "hepatitis" should still find HBV.
const hep = find("hepatitis");
check("hepatitis still finds HBV", hep.keys.includes("HBV"), true);

// Word-boundary matching, or "hiv" fires on "archive" and "flu" on "cauliflower".
check("exclusions do not match inside unrelated words",
  [find("archive").note, find("cauliflower").note], [null, null]);

// Nothing in the exclusion list may name something the catalog actually has,
// or a real sample would be reported as deliberately missing.
check("no exclusion shadows a bundled sample",
  EXCLUDED.flatMap((e) => e.terms).filter((t) => (searchSamples(t, SAMPLES).keys || []).length > 0), []);

// --- NCBI search returns candidates, never a verdict -------------------------
// Fed a recorded response rather than the live API, so this pins the shape and
// the digestibility rules without depending on the network. The records are
// real: these are the first hits NCBI actually returns for "COVID 19" and for
// SARS-CoV-2, which is the whole argument for making this a picker.
const fakeNcbi = (search, summary) => async (url) => ({
  ok: true,
  json: async () => (url.includes("esearch") ? search : summary),
});
const ncbi = await searchNcbi("COVID 19", {
  fetchImpl: fakeNcbi(
    { esearchresult: { count: "185232", idlist: ["1", "2", "3"] } },
    { result: {
      uids: ["1", "2", "3"],
      1: { accessionversion: "PZ502748.1", title: "Klebsiella pneumoniae strain NMI5947/24 plasmid p5947FH.",
           slen: 360919, topology: "circular", moltype: "dna", strand: "ds" },
      2: { accessionversion: "PZ818926.1", title: "Severe acute respiratory syndrome coronavirus 2 isolate",
           slen: 29841, topology: "linear", moltype: "rna", strand: "ss" },
      3: { accessionversion: "NC_001422.1", title: "Escherichia phage phiX174",
           slen: 5386, topology: "circular", moltype: "dna", strand: "ss" },
    } }),
});
check("the true hit count is reported, not just the page", ncbi.total, 185232);
check("every hit comes back, unranked", ncbi.hits.map((h) => h.accession),
  ["PZ502748.1", "PZ818926.1", "NC_001422.1"]);
// The top hit for "COVID 19" really is a Klebsiella plasmid. Auto-loading it
// would be a confident wrong answer, which is why the UI must not choose.
check("the top COVID hit is an unrelated plasmid", /Klebsiella/.test(ncbi.hits[0].title), true);
check("dsDNA is digestible with no caveat",
  [ncbi.hits[0].digestible, ncbi.hits[0].caveat], [true, null]);
check("RNA is flagged as not digestible", ncbi.hits[1].digestible, false);
check("with a reason", /RNA/.test(ncbi.hits[1].caveat), true);
check("ssDNA is digestible but caveated",
  [ncbi.hits[2].digestible, /replicative/.test(ncbi.hits[2].caveat)], [true, true]);

// esummary reports "not-set" for records that never declared a topology;
// printing that verbatim reads like a broken field.
const noTopo = await searchNcbi("x", {
  fetchImpl: fakeNcbi({ esearchresult: { count: "1", idlist: ["1"] } },
    { result: { uids: ["1"], 1: { accessionversion: "X.1", title: "t", slen: 10,
                                  topology: "not-set", moltype: "dna", strand: "ds" } } }),
});
check("an undeclared topology is absent, not \"not-set\"", noTopo.hits[0].topology, null);

check("an empty result set is not an error",
  await searchNcbi("zzz", { fetchImpl: fakeNcbi({ esearchresult: { count: "0", idlist: [] } }, {}) }),
  { total: 0, hits: [] });

// --- Cutting a feature out in one piece -------------------------------------
const featureNamed = (label) =>
  pbr.features.find((f) => f.label === label && f.type === "CDS") ||
  pbr.features.find((f) => f.label === label);
const excise = (label, opts = {}) =>
  excisionOptions(pbr.sequence, true, featureNamed(label), { methylation: "dam_dcm", tier: 2, ...opts });

const tetOptions = excise("tet");
check("tet can be excised from pBR322", tetOptions.length > 0, true);

// The defining property: nothing may cut inside the feature, or it is destroyed
// rather than excised.
//
// Asserting this over the pBR322 options is true but useless as a regression
// test — removing *both* guards in excisionOptions leaves it green, because on
// real DNA the well-scoring options happen not to cut inside anyway. So the
// property is pinned on a constructed case instead: poly-A carrying one EcoRI
// site inside the feature and no other site anywhere. Exactly three enzymes cut
// this sequence (EcoRI, MluCI, Tsp509I), all at the same position inside the
// gene, so a correct search has nothing to offer.
const trapSeq = "A".repeat(200) + "GAATTC" + "A".repeat(200);
const trapFeature = { label: "g", type: "CDS", segments: [{ start: 150, end: 260 }] };
check("an enzyme cutting only inside the feature is never offered",
  excisionOptions(trapSeq, true, trapFeature, { tier: 3 }), []);

const tetSpan = featureNamed("tet").segments;
const insideTet = (names) => {
  const cuts = [...new Set(names.flatMap((n) =>
    findCuts(pbr.sequence, lookup(n), true, "dam_dcm")))];
  const lo = Math.min(...tetSpan.map((s) => s.start)), hi = Math.max(...tetSpan.map((s) => s.end));
  return cuts.filter((c) => c > lo && c < hi).length;
};
check("no excision option cuts inside tet",
  tetOptions.every((o) => insideTet(o.names) === 0), true);

// The excised fragment has to actually contain the feature, with the reported
// flanks adding up — otherwise "1,396 bp" is a number with no meaning.
const tetLen = Math.max(...tetSpan.map((s) => s.end)) - Math.min(...tetSpan.map((s) => s.start));
check("flanks and feature account for the whole fragment",
  tetOptions.every((o) => o.upstream + tetLen + o.downstream === o.size), true);
check("the fragment is at least as long as the feature",
  tetOptions.every((o) => o.size >= tetLen), true);

// AvaI + HindIII is the expected answer: HindIII cuts at 29, upstream of tet
// (85..1276), and AvaI at 1425 downstream, so the gene comes off in 1,396 bp.
check("best tet excision is AvaI + HindIII", tetOptions[0].names.sort(), ["AvaI", "HindIII"]);
check("and the fragment is 1,396 bp", tetOptions[0].size, 1396);

// bla is a different gene at the other end of the plasmid, so a real search
// must return different enzymes — not whatever scored well last time.
const blaOptions = excise("bla");
check("bla excises too", blaOptions.length > 0, true);
check("bla needs different enzymes than tet",
  blaOptions[0].names.join("+") === tetOptions[0].names.join("+"), false);
check("no bla option cuts inside tet's neighbour gene",
  blaOptions.every((o) => {
    const span = featureNamed("bla").segments;
    const lo = Math.min(...span.map((s) => s.start)), hi = Math.max(...span.map((s) => s.end));
    const cuts = [...new Set(o.names.flatMap((n) =>
      findCuts(pbr.sequence, lookup(n), true, "dam_dcm")))];
    return cuts.filter((c) => c > lo && c < hi).length === 0;
  }), true);

// Enzyme pairs that cannot share one tube must never be offered, the same rule
// Suggest follows.
check("no excision pair clashes on temperature",
  [...tetOptions, ...blaOptions].every((o) => !bufferWarning(o.names.map(lookup))), true);

check("a feature spanning the whole molecule cannot be excised",
  excisionOptions("ACGT".repeat(50), true,
    { label: "x", type: "CDS", segments: [{ start: 0, end: 200 }] }, {}), []);

// --- Pulsed-field mode ------------------------------------------------------
// The λ PFG marker is a concatemer series, so every rung must be an exact
// multiple of the λ genome — the one ladder whose values need no outside source.
const LAMBDA = 48502;
check("λ genome length matches the bundled sample", SAMPLES.lambda.sequence.length, LAMBDA);
check("λ PFG rungs are all λ multiples",
  LADDERS["lambda-pfg"].sizes.every((s) => s % LAMBDA === 0), true);
check("λ PFG ladder tops out at 21 concatemers", Math.max(...LADDERS["lambda-pfg"].sizes), 21 * LAMBDA);

// The yeast ladder and the bundled yeast sample come from different places (a
// hand-entered reference table and an NCBI fetch). They must still agree.
check("yeast ladder chromosome I matches the bundled sample",
  Math.min(...LADDERS["yeast-chr"].sizes), SAMPLES.yeastChrI.length);
check("yeast ladder has 16 chromosomes", LADDERS["yeast-chr"].sizes.length, 16);

// Ladders partition cleanly by mode: a 1 kb ladder on a pulsed-field gel is
// meaningless, and the UI rebuilds the list from this.
const agaroseKeys = laddersFor("agarose").map(([k]) => k);
const pfgeKeys = laddersFor("pfge").map(([k]) => k);
check("every ladder belongs to exactly one mode",
  agaroseKeys.length + pfgeKeys.length, Object.keys(LADDERS).length);
check("no ladder is in both modes", agaroseKeys.some((k) => pfgeKeys.includes(k)), false);
check("both modes offer at least one ladder", agaroseKeys.length > 0 && pfgeKeys.length > 0, true);

// Each PFGE programme must resolve upward from the last, and together they must
// cover both pulsed-field ladders — otherwise a ladder exists that no run shows.
const runs = Object.values(PFGE_RUNS);
check("PFGE windows ascend",
  runs.every((r, i) => i === 0 || r.range[0] >= runs[i - 1].range[0]), true);
check("PFGE windows are non-empty", runs.every((r) => r.range[1] > r.range[0]), true);
const widest = [Math.min(...runs.map((r) => r.range[0])), Math.max(...runs.map((r) => r.range[1]))];
for (const key of pfgeKeys) {
  const s = LADDERS[key].sizes;
  check(`${key} fits inside some PFGE window`,
    Math.min(...s) >= widest[0] && Math.max(...s) <= widest[1], true);
}

// The size window must never invert. The 1-6 s programme (10-150 kb) and the
// yeast ladder (230 kb up) do not overlap at all, and that pairing is reachable
// from the UI; unguarded it produced a negative axis span and stacked every
// band on the bottom edge with no error.
for (const [runKey, run] of Object.entries(PFGE_RUNS)) {
  for (const ladderKey of pfgeKeys) {
    const [lo, hi] = sizeWindow(run.range[0], run.range[1], LADDERS[ladderKey].sizes);
    check(`window stays positive: ${runKey} + ${ladderKey}`, lo < hi, true);
  }
}
const noOverlap = sizeWindow(...PFGE_RUNS.short.range, LADDERS["yeast-chr"].sizes);
check("a non-overlapping programme falls back to the ladder's own span",
  noOverlap[0] < Math.min(...LADDERS["yeast-chr"].sizes) &&
  noOverlap[1] > Math.max(...LADDERS["yeast-chr"].sizes), true);

// sizeLabel had a bug that turned "10 Mb" into "1 Mb" by stripping a trailing
// zero from an integer, so the megabase branch is pinned in both forms.
check("sizeLabel bp", sizeLabel(250), "250 bp");
check("sizeLabel kb", sizeLabel(48502), "48.5 kb");
check("sizeLabel whole kb", sizeLabel(10000), "10 kb");
check("sizeLabel Mb", sizeLabel(1531933), "1.53 Mb");
check("sizeLabel whole Mb", sizeLabel(2000000), "2 Mb");
check("sizeLabel ten Mb keeps both digits", sizeLabel(10000000), "10 Mb");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
