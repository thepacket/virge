// Suggest digests for the loaded DNA.
//
// The point is to propose a digest that answers a *question*, not one that makes
// a pretty gel. An earlier version optimised band spread alone, and the result
// was measurably toy-like: on annotated DNA every suggestion cut straight
// through annotated genes, it occasionally proposed enzyme pairs that cannot
// share a tube, and it offered isoschizomers (HpaII/MspI, both CCGG) as if they
// were different digests.
//
// So scoring is now driven by a stated purpose, every component is normalised to
// 0..1 before weighting (otherwise one term silently dominates and the rest stop
// mattering), candidates that are physically un-performable are rejected, and
// duplicates are detected by the cuts they produce rather than by name.
import { ENZYMES, lookup, bufferWarning } from "./enzymes.js";
import { findCuts, fragmentsFromCuts } from "./digest.js";
import { featuresCutBy } from "./genbank.js";


/**
 * What the suggestions are for. `bands` is the band count being aimed at and
 * `tolerance` how sharply to insist on it; the weights say what matters.
 */
const PURPOSES = {
  // Confirm a construct: a few clearly separated bands you can read off a gel.
  diagnostic: {
    label: "diagnosis",
    bands: 5, tolerance: 2.5, maxCuts: 12,
    weights: { resolved: 3, separation: 2.5, countFit: 3, spread: 1.5, featureSafety: 2, common: 1 },
  },
  // Cut a construct open without destroying what is inside it.
  cloning: {
    label: "cloning",
    bands: 2, tolerance: 1.2, maxCuts: 4,
    weights: { resolved: 2, separation: 2, countFit: 3.5, spread: 0.5, featureSafety: 5, common: 1.5 },
  },
  // Tell samples apart: many bands, and cutting inside genes is irrelevant.
  fingerprint: {
    label: "fingerprinting",
    bands: 12, tolerance: 5, maxCuts: 30,
    weights: { resolved: 3.5, separation: 3, countFit: 1.5, spread: 2, featureSafety: 0, common: 0.5 },
  },
};

export const SUGGEST_PURPOSES = Object.entries(PURPOSES).map(([id, p]) => ({ id, label: p.label }));

/** Fraction of cuts that land inside a feature worth protecting. A cut inside
 *  two overlapping features is still one bad cut, so the positions are counted
 *  once rather than once per feature. */
function cutsInsideFeatures(cuts, features) {
  if (!cuts.length) return 0;
  const bad = new Set(featuresCutBy(cuts, features).flatMap((h) => h.cuts));
  return bad.size / cuts.length;
}

function score({ sizes, cuts, enzymes, features, minBp, maxBp, purpose }) {
  const n = sizes.length;
  if (n < 2) return null;                       // nothing to read off a gel
  if (cuts.length > purpose.maxCuts) return null;

  const logs = sizes.map((s) => Math.log10(s)).sort((a, b) => a - b);

  // Every component below is 0..1, so the weights are the only thing deciding
  // what matters. The previous version's failure was an unbounded band-count
  // reward swamping a bounded band-count penalty, which pinned every suggestion
  // to the top of the allowed range.
  const resolved = sizes.filter((s) => s >= minBp && s <= maxBp).length / n;

  // Fraction of neighbouring bands far enough apart to tell apart by eye.
  let separable = 0;
  for (let i = 1; i < n; i++) if (logs[i] - logs[i - 1] > 0.045) separable++;
  const separation = n > 1 ? separable / (n - 1) : 1;

  // Actually targets the band count now, rather than nudging at it.
  const countFit = Math.exp(-(((n - purpose.bands) / purpose.tolerance) ** 2));

  const spread = Math.min((logs[n - 1] - logs[0]) / 2, 1);
  const featureSafety = 1 - cutsInsideFeatures(cuts, features);
  // Tier 1 is an everyday enzyme, tier 2 commonly stocked.
  const common = enzymes.reduce((acc, e) => acc + (e.tier === 1 ? 1 : 0.7), 0) / enzymes.length;

  const parts = { resolved, separation, countFit, spread, featureSafety, common };
  let total = 0, denom = 0;
  for (const [k, weight] of Object.entries(purpose.weights)) {
    total += parts[k] * weight;
    denom += weight;
  }
  return { value: total / denom, parts };
}

/**
 * Returns up to `count` enzyme-name sets, best first.
 *
 * `existing` is a list of `enzyme+enzyme` keys already on the gel; `features`
 * are the loaded DNA's annotations, when it has any.
 */
export function suggestDigests(seq, circular, {
  minBp = 150, maxBp = 20000, count = 3, existing = [], methylation = "none",
  maxTier = 2, features = [], purpose = "diagnostic",
} = {}) {
  const spec = PURPOSES[purpose] || PURPOSES.diagnostic;
  const len = seq.length;

  // Precompute cuts once per enzyme. Enzymes silenced by the current
  // methylation context drop out here for free.
  const cutsByEnzyme = new Map();
  for (const e of ENZYMES) {
    if (e.tier > maxTier) continue;
    const cuts = findCuts(seq, e, circular, methylation);
    if (cuts.length > 0 && cuts.length <= spec.maxCuts) cutsByEnzyme.set(e.name, cuts);
  }
  const cutters = [...cutsByEnzyme.keys()];

  const candidates = [];
  // Two enzyme sets cutting in the same places are the same experiment, however
  // differently they are named — isoschizomers like HpaII/MspI, or a pair whose
  // second enzyme adds nothing. Keying on cut positions collapses those.
  const seenCutSignature = new Set();

  const evaluate = (names) => {
    const enzymes = names.map(lookup);

    // Reject what cannot be done in one tube. VIRGE already warns about this
    // when you build such a lane by hand; suggesting it anyway was incoherent.
    if (bufferWarning(enzymes)) return;

    const cuts = [...new Set(names.flatMap((n) => cutsByEnzyme.get(n)))].sort((a, b) => a - b);

    // A pair cutting exactly where one member already cuts is not a double
    // digest; keep the single instead.
    if (names.length > 1 && names.some((n) => cutsByEnzyme.get(n).length === cuts.length)) return;

    const signature = cuts.join(",");
    if (seenCutSignature.has(signature)) return;
    seenCutSignature.add(signature);

    const sizes = fragmentsFromCuts(cuts, len, circular).map((f) => f.size);
    const scored = score({ sizes, cuts, enzymes, features, minBp, maxBp, purpose: spec });
    if (scored) candidates.push({ names, score: scored.value, parts: scored.parts, bands: sizes.length });
  };

  for (const n of cutters) evaluate([n]);
  for (let i = 0; i < cutters.length; i++)
    for (let j = i + 1; j < cutters.length; j++) evaluate([cutters[i], cutters[j]]);

  candidates.sort((a, b) => b.score - a.score);

  if (!candidates.length) return [];

  // Returning fewer good options beats padding the list with a bad one. Without
  // this floor the diversity rule below could starve the last slot and fall back
  // to something that badly misses the purpose — a 2-band digest offered for
  // fingerprinting, say.
  const floor = candidates[0].score * 0.6;

  const existingKeys = new Set(existing);
  const picked = [];
  // Diversity without starvation: one enzyme may anchor two suggestions (same
  // backbone cut, different partner is genuinely informative) but not all three,
  // which would just be variations on a theme.
  const timesUsed = new Map();
  const overUsed = (n) => (timesUsed.get(n) || 0) >= 2;

  for (const c of candidates) {
    if (c.score < floor) break;
    const key = [...c.names].sort().join("+");
    if (existingKeys.has(key)) continue;
    if (picked.length && c.names.every((n) => timesUsed.has(n))) continue;
    if (c.names.some(overUsed)) continue;
    picked.push(c.names);
    existingKeys.add(key);
    c.names.forEach((n) => timesUsed.set(n, (timesUsed.get(n) || 0) + 1));
    if (picked.length >= count) break;
  }
  return picked;
}
