// Regression tests — run with: npm test
// Expected values are published restriction maps, not outputs of this code.
import { SAMPLES } from "../src/data/samples.js";
import { lookup, ENZYMES, overhangSignature, compatibleEnds } from "../src/enzymes.js";
import { digest, findSites } from "../src/digest.js";
import { parseAny, sequenceStats, ParseError } from "../src/genbank.js";

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
// Plasmids deposited as linear records must be corrected, or a digest loses the
// junction fragment.
check("circular plasmids corrected",
  ["pACYC177", "RK2", "M13mp18"].map((k) => SAMPLES[k].topology), ["circular", "circular", "circular"]);
check("linear genomes stay linear",
  ["lambda", "T7", "T4", "yeastChrI", "HSV1"].map((k) => SAMPLES[k].topology),
  ["linear", "linear", "linear", "linear", "linear"]);

// --- Catalog integrity ------------------------------------------------------
check("every enzyme has cut coordinates",
  ENZYMES.every((e) => Number.isInteger(e.cutTop) && Number.isInteger(e.cutBottom)), true);
check("every enzyme has a valid site",
  ENZYMES.every((e) => /^[ACGTRYSWKMBDHVN]+$/.test(e.site)), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
