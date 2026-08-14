// Digest engine.
//
// Cut coordinates follow the enzyme data: cutTop / cutBottom are offsets from
// the start of the recognition site on the top strand. For Type IIS enzymes
// they fall outside the site, and they may be negative once a site found on
// the bottom strand is mapped back into top-strand coordinates.
//
// Fragment sizes are computed from top-strand cut positions, the same
// convention used by suppliers' published fragment tables.

const IUPAC = {
  A: "A", C: "C", G: "G", T: "T",
  R: "[AG]", Y: "[CT]", S: "[CG]", W: "[AT]", K: "[GT]", M: "[AC]",
  B: "[CGT]", D: "[AGT]", H: "[ACT]", V: "[ACG]", N: "[ACGT]",
};
const RC = { A: "T", T: "A", C: "G", G: "C", R: "Y", Y: "R", S: "S", W: "W",
             K: "M", M: "K", B: "V", V: "B", D: "H", H: "D", N: "N" };

export const revcomp = (s) => s.split("").reverse().map((c) => RC[c] || c).join("");

function siteRegex(site) {
  return new RegExp(site.split("").map((c) => IUPAC[c] || c).join(""), "g");
}

function matchAll(haystack, pattern) {
  const re = siteRegex(pattern);
  const hits = [];
  let m;
  while ((m = re.exec(haystack)) !== null) {
    hits.push(m.index);
    re.lastIndex = m.index + 1; // allow overlapping sites
  }
  return hits;
}

// Positions of a methylase target (e.g. GATC for Dam) as [start, end) spans.
function methylTargets(seq, pattern, circular) {
  const pad = circular ? seq + seq.slice(0, pattern.length - 1) : seq;
  return matchAll(pad, pattern).map((i) => [i, i + pattern.length]);
}

const overlaps = (aStart, aEnd, spans) =>
  spans.some(([s, e]) => aStart < e && s < aEnd);

/**
 * Locate every occurrence of an enzyme's recognition site, on both strands.
 * Returns [{ start, end, strand, topCut, bottomCut, blocked, blockedBy }].
 * Blocked sites are reported rather than dropped so the UI can explain them.
 */
export function findSites(seq, enzyme, circular, methylation = "none") {
  const len = seq.length;
  const L = enzyme.site.length;
  const pad = circular ? seq + seq.slice(0, L - 1) : seq;

  const rcSite = revcomp(enzyme.site);
  const found = new Map(); // key -> site record, dedupes palindromes

  const add = (start, strand) => {
    // Map both cuts into top-strand coordinates.
    const topCut = strand === 1 ? start + enzyme.cutTop : start + L - enzyme.cutBottom;
    const bottomCut = strand === 1 ? start + enzyme.cutBottom : start + L - enzyme.cutTop;
    const key = `${topCut}:${bottomCut}`;
    if (!found.has(key)) found.set(key, { start, end: start + L, strand, topCut, bottomCut });
  };

  for (const i of matchAll(pad, enzyme.site)) add(i, 1);
  if (rcSite !== enzyme.site) for (const i of matchAll(pad, rcSite)) add(i, -1);

  // Methylation blocking: the methylase target must overlap the site.
  const dam = methylation === "dam_dcm" ? methylTargets(seq, "GATC", circular) : [];
  const dcm = methylation === "dam_dcm" ? methylTargets(seq, "CCWGG", circular) : [];
  const cpg = methylation === "cpg" ? methylTargets(seq, "CG", circular) : [];

  const sites = [];
  for (const s of found.values()) {
    if (s.start >= len) continue; // wrapped duplicate of a site already counted
    let blocked = false, blockedBy = null;

    if (enzyme.dam === "required") {
      // DpnI only cuts methylated DNA.
      if (methylation !== "dam_dcm") { blocked = true; blockedBy = "needs Dam methylation"; }
    } else if (enzyme.dam === "blocked" && overlaps(s.start, s.end, dam)) {
      blocked = true; blockedBy = "Dam (GATC)";
    }
    if (!blocked && enzyme.dcm === "blocked" && overlaps(s.start, s.end, dcm)) {
      blocked = true; blockedBy = "Dcm (CCWGG)";
    }
    if (!blocked && methylation === "cpg" && enzyme.cpgBlocked && overlaps(s.start, s.end, cpg)) {
      blocked = true; blockedBy = "CpG methylation";
    }
    sites.push({ ...s, blocked, blockedBy });
  }
  sites.sort((a, b) => a.topCut - b.topCut);
  return sites;
}

/** Top-strand cut positions of the sites this enzyme will actually cut. */
export function findCuts(seq, enzyme, circular, methylation = "none") {
  const len = seq.length;
  const cuts = new Set();
  for (const s of findSites(seq, enzyme, circular, methylation)) {
    if (s.blocked) continue;
    let p = s.topCut;
    if (circular) p = ((p % len) + len) % len;
    else if (p < 0 || p > len) continue; // Type IIS cut running off a linear end
    cuts.add(p);
  }
  return [...cuts].sort((a, b) => a - b);
}

/** cuts must be sorted unique positions in [0, len). Fragments sorted by size desc. */
export function fragmentsFromCuts(cuts, len, circular) {
  const fragments = [];
  if (circular) {
    for (let i = 0; i < cuts.length; i++) {
      const start = cuts[i];
      const end = cuts[(i + 1) % cuts.length];
      const size = i === cuts.length - 1 ? len - start + cuts[0] : end - start;
      if (size > 0) fragments.push({ size, start, end });
    }
  } else {
    const bounds = [0, ...cuts.filter((p) => p > 0 && p < len), len];
    for (let i = 0; i < bounds.length - 1; i++) {
      const size = bounds[i + 1] - bounds[i];
      if (size > 0) fragments.push({ size, start: bounds[i], end: bounds[i + 1] });
    }
  }
  fragments.sort((a, b) => b.size - a.size);
  return fragments;
}

/**
 * Digest `seq` with one or more enzymes.
 * opts: { methylation: "none" | "dam_dcm" | "cpg" }
 */
export function digest(seq, enzymes, circular, opts = {}) {
  const { methylation = "none" } = opts;
  const len = seq.length;
  const all = new Set();
  let blocked = 0;

  for (const e of enzymes) {
    for (const s of findSites(seq, e, circular, methylation)) {
      if (s.blocked) { blocked++; continue; }
      let p = s.topCut;
      if (circular) p = ((p % len) + len) % len;
      else if (p < 0 || p > len) continue;
      all.add(p);
    }
  }
  const cuts = [...all].sort((a, b) => a - b);

  if (cuts.length === 0) {
    return { cuts, fragments: [{ size: len, start: 0, end: len }], uncut: true, blocked };
  }
  return { cuts, fragments: fragmentsFromCuts(cuts, len, circular), uncut: false, blocked };
}
