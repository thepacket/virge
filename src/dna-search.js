// Finding DNA by name.
//
// The obvious implementation — hand the query to NCBI esearch and load the top
// hit — is actively harmful here, and measurably so. Searching nuccore for
// "COVID 19" returns 185,232 records whose first five are *Klebsiella
// pneumoniae plasmids* (the pandemic is named in their isolation-source
// metadata). Searching for "pET-28a" returns fifteen records, none of which is
// the vector: a patent sequence, a clam mRNA, a plant transferase, an
// UNVERIFIED construct, an uncultured-bacterium glucanase.
//
// So name lookup is curated, and NCBI search is a picker the user chooses from
// rather than an oracle. This file holds the curated half; it is pure, so the
// tests can hold it to its promises without a network.

/** Extra terms that should find a bundled sample. Common names, the way people
 *  actually type them, and the spellings that differ from the catalog's. */
export const ALIASES = {
  lambda: ["λ", "lambda phage", "bacteriophage lambda", "phage lambda"],
  phiX174: ["φx174", "phi x 174", "phix", "phix174 rf", "øx174"],
  M13: ["m13 wild type", "m13 rf"],
  M13mp18: ["m13 mp18", "mp18"],
  T7: ["t7 bacteriophage"],
  T4: ["t4 bacteriophage"],
  EBV: ["epstein barr", "epstein-barr", "human herpesvirus 4", "hhv-4"],
  HSV1: ["herpes simplex", "hsv", "hsv-1", "human herpesvirus 1", "cold sore"],
  VZV: ["varicella", "zoster", "chickenpox", "shingles", "human herpesvirus 3"],
  HPV16: ["papillomavirus", "hpv", "hpv-16", "wart virus", "cervical cancer virus"],
  HBV: ["hepatitis b", "hep b"],
  SV40: ["simian virus 40", "simian vacuolating virus"],
  adeno5: ["adenovirus", "ad5", "adenovirus type 5"],
  vaccinia: ["smallpox vaccine", "poxvirus", "vaccinia virus wr"],
  humanMito: ["mtdna", "mitochondrial dna", "rcrs", "human mitochondrial genome",
              "mitochondria", "chondriome"],
  yeastMito: ["yeast mitochondrial dna", "s. cerevisiae mitochondrion"],
  chloroplast: ["plastid", "cpdna", "arabidopsis plastid", "chloroplast genome"],
  yeastChrI: ["saccharomyces chromosome 1", "yeast chromosome 1", "chrI"],
  ecoliK12: ["e coli", "escherichia coli", "mg1655", "k12", "k-12"],
  ecoliO157: ["e coli o157", "sakai", "ehec", "o157:h7"],
  bsubtilis: ["bacillus subtilis", "b subtilis", "subtilis 168"],
  pUC19: ["puc 19", "puc-19"],
  pUC18: ["puc 18", "puc-18"],
  pBR322: ["pbr 322", "pbr-322"],
  pEGFP_N1: ["egfp", "gfp", "green fluorescent protein", "pegfp n1"],
  pEGFP_C1: ["egfp c1", "pegfp c1"],
  pGEX_4T1: ["gst", "glutathione s-transferase", "pgex 4t-1"],
  pGEX_6P1: ["pgex 6p-1", "precission"],
  twoMicron: ["2 micron", "2-micron", "2u", "yeast 2 micron plasmid"],
  tiPlasmid: ["agrobacterium", "tumefaciens", "ti plasmid"],
  fPlasmid: ["f factor", "fertility factor", "f-plasmid"],
  RK2: ["rp4", "incp", "broad host range plasmid"],
  pPCP1: ["yersinia", "plague plasmid", "pesticin"],
  pBI121: ["binary vector", "gus", "beta-glucuronidase"],
};

/**
 * Things people look for that VIRGE deliberately does not carry.
 *
 * A search that finds nothing teaches nothing. Each entry says *why*, because
 * in both cases the reason is the useful answer: the molecule cannot be cut, or
 * the sequence does not exist in GenBank in a usable form.
 */
export const EXCLUDED = [
  {
    terms: ["covid", "covid 19", "covid-19", "sars-cov-2", "sars cov 2", "sarscov2",
            "coronavirus", "wuhan", "ncov", "sars2"],
    title: "SARS-CoV-2",
    reason:
      "SARS-CoV-2 is an RNA virus (NC_045512 is ss-RNA), and restriction enzymes cut " +
      "double-stranded DNA only. A digest of it is not an experiment that exists — you " +
      "would need a cDNA clone, which has no single accession.",
  },
  {
    // "flu" is deliberately absent: it is a substring of "green fluorescent
    // protein", so it would report the GFP vectors as a missing RNA virus.
    // A regression test enforces that no exclusion term names something the
    // catalog actually carries.
    terms: ["influenza", "hiv", "rabies", "ebola", "measles", "polio",
            "hepatitis c", "hcv", "zika", "dengue", "rsv", "rna virus", "retrovirus"],
    title: "RNA viruses",
    reason:
      "RNA virus genomes cannot be cut by restriction enzymes, which need a DNA duplex. " +
      "Only the DNA viruses are carried.",
  },
  {
    terms: ["pet28", "pet-28a", "pet28a", "pet 28", "pcdna3", "pcdna 3.1", "pmal",
            "pfastbac", "plko", "plko.1", "pspax2", "pmd2.g", "px330", "lenticrisprv2",
            "lenticrispr", "pcambia", "pgex-2t", "addgene", "snapgene"],
    title: "Commercial and Addgene vectors",
    reason:
      "These have no clean GenBank deposition — searching NCBI for “pET-28a” returns a " +
      "patent fragment, a clam mRNA and an uncultured-bacterium glucanase, but not the " +
      "vector. Download the GenBank file from Addgene or your supplier and drop it on " +
      "the panel below; its annotations come with it.",
  },
];

const norm = (s) => String(s).toLowerCase().replace(/[_.\-–—]+/g, " ").replace(/\s+/g, " ").trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word match, plus a prefix so a live search box reacts while typing.
 *  Substring matching would fire "hiv" on "archive" and "flu" on "cauliflower". */
function matchesTerm(q, term) {
  const t = norm(term);
  if (!t) return false;
  if (new RegExp(`(^|\\s)${escapeRe(t)}(\\s|$)`).test(q)) return true;
  return q.length > 3 && t.startsWith(q);
}

/**
 * Search the bundled catalog by name, description and curated aliases.
 *
 * Returns `{ keys, note }`. `note` is set when the query names something
 * deliberately absent, so the UI can explain rather than show an empty list —
 * and it is returned *alongside* any matches, since "hepatitis" legitimately
 * finds HBV while also being worth a word about hepatitis C.
 */
export function searchSamples(query, samples) {
  const q = norm(query);
  if (!q) return { keys: null, note: null };   // null keys = no filter at all

  const keys = [];
  for (const [key, s] of Object.entries(samples)) {
    const hay = [key, s.name, s.description || "", s.group, ...(ALIASES[key] || [])]
      .map(norm).join(" | ");
    if (hay.includes(q)) keys.push(key);
  }

  // Word-level fallback, so "yeast chromosome" finds "Yeast chromosome I" and
  // "coli genome" finds the two E. coli entries. Every word must appear.
  if (!keys.length) {
    const words = q.split(" ").filter((w) => w.length > 2);
    if (words.length > 1) {
      for (const [key, s] of Object.entries(samples)) {
        const hay = [key, s.name, s.description || "", s.group, ...(ALIASES[key] || [])]
          .map(norm).join(" | ");
        if (words.every((w) => hay.includes(w))) keys.push(key);
      }
    }
  }

  const hit = EXCLUDED.find((e) => e.terms.some((t) => matchesTerm(q, t)));
  return { keys, note: hit ? { title: hit.title, reason: hit.reason } : null };
}

/**
 * Search NCBI nuccore and describe every candidate.
 *
 * Deliberately returns the whole list with its metadata rather than picking:
 * the top hit for "COVID 19" is a Klebsiella plasmid, and no ranking this code
 * could apply would fix that. `moltype` and `strand` come back so the caller
 * can mark what a restriction enzyme cannot cut.
 */
export async function searchNcbi(term, { retmax = 20, fetchImpl = fetch } = {}) {
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
  const searchUrl = `${base}esearch.fcgi?db=nuccore&retmode=json&retmax=${retmax}` +
                    `&term=${encodeURIComponent(term)}`;
  const sres = await fetchImpl(searchUrl);
  if (!sres.ok) throw new Error(`NCBI search returned ${sres.status}`);
  const sjson = await sres.json();
  const ids = sjson?.esearchresult?.idlist || [];
  const total = Number(sjson?.esearchresult?.count || 0);
  if (!ids.length) return { total, hits: [] };

  const sumUrl = `${base}esummary.fcgi?db=nuccore&retmode=json&id=${ids.join(",")}`;
  const ures = await fetchImpl(sumUrl);
  if (!ures.ok) throw new Error(`NCBI summary returned ${ures.status}`);
  const { result } = await ures.json();

  const hits = (result?.uids || []).map((uid) => {
    const r = result[uid];
    return {
      accession: r.accessionversion,
      title: (r.title || "").replace(/\.$/, ""),
      length: r.slen,
      // esummary says "not-set" for records that never declared one; printing
      // that verbatim reads like a broken field rather than an absent fact.
      topology: r.topology && r.topology !== "not-set" ? r.topology : null,
      moltype: r.moltype,
      strand: r.strand,
      // The same rule the sample build enforces: RNA is not cuttable at all,
      // and a single strand is only cuttable as its replicative form.
      digestible: r.moltype === "dna",
      caveat: r.moltype !== "dna"
        ? "RNA — restriction enzymes cannot cut it"
        : r.strand === "ss" ? "single-stranded — only its replicative form can be cut" : null,
    };
  });
  return { total, hits };
}
