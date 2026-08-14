// Enzyme catalog and presentation helpers.
// The data itself is generated from REBASE — see scripts/build-enzymes.mjs.
import { ENZYME_DATA } from "./data/enzymes.js";

export const ENZYMES = ENZYME_DATA.map((e) => ({
  ...e,
  // Type IIS enzymes cut outside their recognition site.
  typeIIS: e.cutTop > e.site.length || e.cutBottom > e.site.length || e.cutTop < 0,
  // A site containing CG can be blocked by eukaryotic CpG methylation.
  // MspI is the classic exception: it cuts CCGG even when the CpG is methylated.
  cpgBlocked: e.site.includes("CG") && e.name !== "MspI",
  temp: e.temp ?? 37,
}));

export const ENZYMES_BY_NAME = new Map(ENZYMES.map((e) => [e.name, e]));

export function lookup(name) {
  return ENZYMES_BY_NAME.get(name);
}

/** Overhang length: >0 is a 5' overhang, <0 a 3' overhang, 0 blunt. */
export function overhang(enzyme) {
  return enzyme.cutBottom - enzyme.cutTop;
}

export function endType(enzyme) {
  const o = overhang(enzyme);
  if (o === 0) return "blunt";
  return `${Math.abs(o)} nt ${o > 0 ? "5′" : "3′"} overhang`;
}

/** Display form of the cut: "G^AATTC" for Type IIP, "GGTCTC(1/5)" for Type IIS. */
export function siteWithCut(enzyme) {
  const { site, cutTop, cutBottom } = enzyme;
  if (!enzyme.typeIIS && cutTop >= 0 && cutTop <= site.length) {
    return site.slice(0, cutTop) + "^" + site.slice(cutTop);
  }
  return `${site}(${cutTop - site.length}/${cutBottom - site.length})`;
}

/** The single-stranded overhang an enzyme leaves, read 5'→3'. */
export function overhangSeq(seq, site) {
  const lo = Math.min(site.topCut, site.bottomCut);
  const hi = Math.max(site.topCut, site.bottomCut);
  if (lo === hi) return "";
  return seq.slice(Math.max(0, lo), Math.max(0, hi));
}

/**
 * The sticky end an enzyme leaves, when it is fixed by the recognition site.
 * Type IIS enzymes cut outside their site, so their overhang is defined by
 * whatever flanking sequence they land on — that is exactly what makes them
 * programmable for Golden Gate, and it is reported as variable here.
 */
export function overhangSignature(enzyme) {
  const o = overhang(enzyme);
  if (o === 0) return { kind: "blunt", seq: "", key: "blunt" };
  const lo = Math.min(enzyme.cutTop, enzyme.cutBottom);
  const hi = Math.max(enzyme.cutTop, enzyme.cutBottom);
  if (lo < 0 || hi > enzyme.site.length) return { kind: "variable", seq: null, key: null };
  const seq = enzyme.site.slice(lo, hi);
  if (/[^ACGT]/.test(seq)) return { kind: "variable", seq: null, key: null }; // degenerate site
  const kind = o > 0 ? "5′" : "3′";
  return { kind, seq, key: `${kind}:${seq}` };
}

// Enzymes grouped by the sticky end they leave. Ends in the same group ligate
// to each other even though the enzymes differ — BamHI/BglII/BclI/Sau3AI all
// leave GATC, so any of them can accept an insert cut with any other.
const byEndKey = new Map();
for (const e of ENZYMES) {
  const sig = overhangSignature(e);
  if (!sig.key || sig.key === "blunt") continue;
  if (!byEndKey.has(sig.key)) byEndKey.set(sig.key, []);
  byEndKey.get(sig.key).push(e.name);
}

/** Other enzymes leaving an end that will ligate to this one's. */
export function compatibleEnds(enzyme) {
  const sig = overhangSignature(enzyme);
  if (!sig.key || sig.key === "blunt") return [];
  return (byEndKey.get(sig.key) || []).filter((n) => n !== enzyme.name);
}

/** Blunt cutters all ligate to one another (inefficiently, but they do). */
export function bluntCutters() {
  return ENZYMES.filter((e) => overhang(e) === 0).map((e) => e.name);
}

export const TIER_LABEL = { 1: "Everyday", 2: "Common", 3: "Specialist" };

/** Enzymes whose incubation temperatures differ can't share one reaction. */
export function bufferWarning(enzymes) {
  if (enzymes.length < 2) return null;
  const temps = [...new Set(enzymes.map((e) => e.temp))];
  if (temps.length > 1) {
    const detail = enzymes.map((e) => `${e.name} ${e.temp}°C`).join(", ");
    return `Different incubation temperatures (${detail}) — run as a sequential digest.`;
  }
  return null;
}
