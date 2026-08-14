// Fetches the built-in DNA samples from NCBI as GenBank flat files and writes
// src/data/samples.js, including annotated features where the record has them.
// Uses the same parser the browser uses for uploads (src/genbank.js).
//
// Usage: node scripts/build-samples.mjs
import fs from "node:fs";
import { parseGenBank } from "../src/genbank.js";

const OUT = "src/data/samples.js";
const CACHE = "data-src/gb";

// Every accession here was verified against NCBI esummary before being added —
// title searches for vector names return a lot of unrelated fragments.
// Sequences up to BUNDLE_LIMIT are embedded; larger ones carry metadata only
// and are fetched on demand at runtime, so the bundle stays reasonable while
// whole genomes remain available (rare cutters on a genome is the real
// pulsed-field use case).
const BUNDLE_LIMIT = 62_000;

const SAMPLES = [
  // --- Cloning vectors ---
  { key: "pUC19",         acc: "L09137.2",    name: "pUC19",                 group: "Cloning vectors" },
  { key: "pUC18",         acc: "L08752.1",    name: "pUC18",                 group: "Cloning vectors" },
  { key: "pBR322",        acc: "J01749.1",    name: "pBR322",                group: "Cloning vectors" },
  { key: "pACYC177",      acc: "X06402.1",    name: "pACYC177",              group: "Cloning vectors" },
  { key: "pACYC184",      acc: "X06403.1",    name: "pACYC184",              group: "Cloning vectors" },
  { key: "pBluescriptSK", acc: "X52328.1",    name: "pBluescript II SK(+)",  group: "Cloning vectors" },
  { key: "pBluescriptKS", acc: "X52327.1",    name: "pBluescript II KS(+)",  group: "Cloning vectors" },
  { key: "pGEM3Zf",       acc: "X65306.2",    name: "pGEM-3Zf(+)",           group: "Cloning vectors" },
  { key: "M13mp18",       acc: "X02513.1",    name: "M13mp18 (RF)",          group: "Cloning vectors" },

  // --- Expression / fusion-tag vectors ---
  { key: "pTrc99a",       acc: "U13872.1",    name: "pTrc99a (trc promoter)", group: "Expression vectors" },
  { key: "pGEX_4T1",      acc: "U13853.1",    name: "pGEX-4T-1 (GST fusion)", group: "Expression vectors" },
  { key: "pGEX_6P1",      acc: "U78872.1",    name: "pGEX-6P-1 (GST fusion)", group: "Expression vectors" },
  { key: "pEGFP_N1",      acc: "U55762.1",    name: "pEGFP-N1 (C-terminal GFP)", group: "Expression vectors" },
  { key: "pEGFP_C1",      acc: "U55763.1",    name: "pEGFP-C1 (N-terminal GFP)", group: "Expression vectors" },

  // --- Yeast ---
  { key: "pRS313",        acc: "U03439.1",    name: "pRS313 (CEN, HIS3)",    group: "Yeast vectors" },
  { key: "pRS314",        acc: "U03440.1",    name: "pRS314 (CEN, TRP1)",    group: "Yeast vectors" },
  { key: "pRS315",        acc: "U03441.1",    name: "pRS315 (CEN, LEU2)",    group: "Yeast vectors" },
  { key: "pRS316",        acc: "U03442.1",    name: "pRS316 (CEN, URA3)",    group: "Yeast vectors" },
  { key: "twoMicron",     acc: "J01347.1",    name: "2-micron circle",       group: "Yeast vectors" },

  // --- Plant / Agrobacterium ---
  { key: "pBI121",        acc: "AF485783.1",  name: "pBI121 (binary vector)", group: "Plant vectors" },
  { key: "tiPlasmid",     acc: "NC_003065.3", name: "Ti plasmid (A. fabrum C58)", group: "Plant vectors" },

  // --- Phage ---
  { key: "lambda",        acc: "J02459.1",    name: "Lambda phage",          group: "Phage genomes" },
  { key: "phiX174",       acc: "NC_001422.1", name: "phiX174 phage",         group: "Phage genomes" },
  { key: "T7",            acc: "NC_001604.1", name: "T7 phage",              group: "Phage genomes" },
  { key: "T4",            acc: "NC_000866.4", name: "T4 phage",              group: "Phage genomes" },
  { key: "M13",           acc: "V00604.2",    name: "M13 phage (wild type)", group: "Phage genomes" },

  // --- Viral genomes ---
  { key: "SV40",          acc: "J02400.1",    name: "SV40",                  group: "Viral genomes" },
  { key: "HPV16",         acc: "NC_001526.4", name: "Human papillomavirus 16", group: "Viral genomes" },
  { key: "HBV",           acc: "NC_003977.2", name: "Hepatitis B virus",     group: "Viral genomes" },
  { key: "SARS2",         acc: "NC_045512.2", name: "SARS-CoV-2 (Wuhan-Hu-1)", group: "Viral genomes" },
  { key: "adeno5",        acc: "AC_000008.1", name: "Human adenovirus 5",    group: "Viral genomes" },
  { key: "HSV1",          acc: "NC_001806.2", name: "Herpes simplex virus 1", group: "Viral genomes" },
  { key: "VZV",           acc: "NC_001348.1", name: "Varicella-zoster virus", group: "Viral genomes" },
  { key: "EBV",           acc: "NC_007605.1", name: "Epstein-Barr virus",    group: "Viral genomes" },
  { key: "vaccinia",      acc: "NC_006998.1", name: "Vaccinia virus",        group: "Viral genomes" },

  // --- Natural plasmids ---
  { key: "pPCP1",         acc: "NC_005816.1", name: "pPCP1 (Y. pestis)",     group: "Natural plasmids" },
  { key: "RK2",           acc: "L27758.1",    name: "RK2 / RP4 (IncP)",      group: "Natural plasmids" },
  { key: "fPlasmid",      acc: "AP001918.1",  name: "F plasmid (E. coli K-12)", group: "Natural plasmids" },

  // --- Bacterial genomes (large: fetched on demand) ---
  { key: "ecoliK12",      acc: "U00096.3",    name: "E. coli K-12 MG1655",   group: "Bacterial genomes" },
  { key: "ecoliO157",     acc: "NC_002695.2", name: "E. coli O157:H7 Sakai", group: "Bacterial genomes" },
  { key: "bsubtilis",     acc: "NC_000964.3", name: "B. subtilis 168",       group: "Bacterial genomes" },

  // --- Organelle / chromosome ---
  { key: "humanMito",     acc: "NC_012920.1", name: "Human mitochondrion",   group: "Organelle & chromosomes" },
  { key: "yeastMito",     acc: "NC_001224.1", name: "Yeast mitochondrion",   group: "Organelle & chromosomes" },
  { key: "chloroplast",   acc: "NC_000932.1", name: "Arabidopsis chloroplast", group: "Organelle & chromosomes" },
  { key: "yeastChrI",     acc: "NC_001133.9", name: "Yeast chromosome I",    group: "Organelle & chromosomes" },
];

// The deposited record is not always the form used at the bench. M13mp18 is
// deposited as the linear phage sequence, but the replicative form people
// digest is circular; pACYC177 and RK2 are likewise circular plasmids whose
// records are flagged linear. Digesting these as linear would drop a fragment
// and lose the junction, so they are corrected here.
const TOPOLOGY_OVERRIDE = {
  lambda: false, T7: false,
  M13mp18: true, pACYC177: true, RK2: true,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(CACHE, { recursive: true });

// One esummary call gives length and title for everything, so we know which
// records to embed without downloading the multi-megabyte genomes first.
async function summarise(accessions) {
  const url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi" +
              `?db=nuccore&id=${accessions.join(",")}&retmode=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`esummary: HTTP ${res.status}`);
  const { result } = await res.json();
  const byAcc = {};
  for (const uid of result.uids) {
    const r = result[uid];
    byAcc[r.accessionversion] = { length: r.slen, title: r.title, topology: r.topology };
  }
  return byAcc;
}

console.log("summarising catalog…");
const summary = await summarise(SAMPLES.map((s) => s.acc));

const out = {};
for (const s of SAMPLES) {
  const info = summary[s.acc];
  if (!info) throw new Error(`${s.acc} (${s.key}): not found at NCBI`);

  const bundled = info.length <= BUNDLE_LIMIT;
  const base = {
    name: s.name,
    group: s.group,
    accession: s.acc,
    description: info.title.replace(/\.$/, ""),
    length: info.length,
  };

  if (!bundled) {
    // Metadata only; the browser fetches the sequence when it is selected.
    // Topology comes from NCBI rather than being assumed.
    const circular = TOPOLOGY_OVERRIDE[s.key] ?? (info.topology === "circular");
    out[s.key] = {
      ...base,
      topology: circular ? "circular" : "linear",
      lazy: true,
      // Records past this size have thousands of features; fetch FASTA instead
      // of a ~3x larger GenBank file that the browser would then have to parse.
      fetchAs: info.length > 500_000 ? "fasta" : "gb",
    };
    console.log(`${s.key.padEnd(14)} ${String(info.length).padStart(9)} bp  on demand (${out[s.key].fetchAs})`);
    continue;
  }

  const path = `${CACHE}/${s.key}.gb`;
  if (!fs.existsSync(path)) {
    process.stdout.write(`fetching ${s.acc}… `);
    // gbwithparts so CON (contig) records come back with their sequence.
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=${s.acc}&rettype=gbwithparts&retmode=text`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${s.acc}: HTTP ${res.status}`);
    fs.writeFileSync(path, await res.text());
    await sleep(400); // be polite to NCBI
  }
  const raw = fs.readFileSync(path, "utf8");
  const rec = parseGenBank(raw);
  if (!rec) throw new Error(`${s.acc}: could not parse GenBank (a CON record with no ORIGIN?)`);
  const declared = parseInt(raw.match(/^LOCUS\s+\S+\s+(\d+) bp/m)[1], 10);
  if (rec.sequence.length !== declared) {
    throw new Error(`${s.acc}: parsed ${rec.sequence.length} bp but LOCUS declares ${declared}`);
  }

  const circular = TOPOLOGY_OVERRIDE[s.key] ?? rec.circular;
  out[s.key] = {
    ...base,
    topology: circular ? "circular" : "linear",
    features: rec.features,
    sequence: rec.sequence,
  };
  console.log(`${s.key.padEnd(14)} ${String(rec.sequence.length).padStart(9)} bp  ${circular ? "circular" : "linear  "}  ${rec.features.length} features`);
}

// Keep the declared group order rather than discovery order.
const groups = [...new Set(SAMPLES.map((s) => s.group))];
fs.writeFileSync(OUT,
  "// GENERATED by scripts/build-samples.mjs — do not edit by hand.\n" +
  "// Sequences and annotations from NCBI GenBank.\n" +
  "export const GROUPS = " + JSON.stringify(groups) + ";\n" +
  "export const SAMPLES = " + JSON.stringify(out, null, 1) + ";\n");

const vals = Object.values(out);
const totalFeatures = vals.reduce((n, s) => n + (s.features?.length || 0), 0);
const lazy = vals.filter((s) => s.lazy).length;
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`\nwrote ${vals.length} samples (${lazy} on demand), ${totalFeatures} features -> ${OUT} (${kb} kB)`);
