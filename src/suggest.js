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

/**
 * Enzyme sets that cut a named feature out in one piece.
 *
 * The bench task behind "cut out this feature": find enzymes that cut on both
 * sides of a gene and nowhere inside it, so the gene comes off the backbone
 * intact and can be gel-purified. Suggest already avoided cutting through genes
 * as one term among six; this optimises for it directly.
 *
 * `feature` is a parsed GenBank feature. Its overall span is used, so a joined
 * CDS is treated as the whole region from first exon start to last exon end —
 * cutting inside an intron would still be reported as unsafe, which is the
 * conservative direction.
 *
 * Returns `[{ names, size, upstream, downstream, cuts }]`, best first:
 * `size` is the excised fragment, `upstream`/`downstream` the flanking DNA
 * carried along with it.
 */
export function excisionOptions(seq, circular, feature, {
  methylation = "none", tier = 2, count = 3, maxCuts = 12,
} = {}) {
  if (!feature?.segments?.length) return [];
  const len = seq.length;
  const featStart = Math.min(...feature.segments.map((s) => s.start));
  const featEnd = Math.max(...feature.segments.map((s) => s.end));
  const featLen = featEnd - featStart;
  if (featLen <= 0 || featLen >= len) return [];

  // Drop enzymes that cut inside the feature. This is a *prune*, not the safety
  // guarantee — the containment search below is what actually enforces it, and
  // removing this line alone leaves every test green. It earns its place on
  // cost: on pBR322/tet it takes the candidate set from 35 enzymes (595 pairs)
  // to 20 (190 pairs).
  //
  // A cut exactly on the boundary is allowed: that is a clean excision, not a
  // broken gene.
  const usable = [];
  for (const e of ENZYMES) {
    if ((e.tier ?? 3) > tier) continue;
    const cuts = findCuts(seq, e, circular, methylation);
    if (!cuts.length || cuts.length > maxCuts) continue;
    if (cuts.some((c) => c > featStart && c < featEnd)) continue;
    usable.push({ e, cuts });
  }

  const results = [];
  const consider = (parts) => {
    const enzymes = parts.map((p) => p.e);
    if (bufferWarning(enzymes)) return;           // cannot share one tube
    const cuts = [...new Set(parts.flatMap((p) => p.cuts))].sort((a, b) => a - b);
    if (cuts.length < (circular ? 2 : 1)) return;

    const frag = fragmentsFromCuts(cuts, len, circular).find((f) => {
      // Circular fragments may wrap past the origin, so containment is checked
      // on the unwrapped interval rather than with a plain start <= end test.
      const end = f.end > f.start ? f.end : f.end + len;
      const fs = featStart < f.start ? featStart + len : featStart;
      const fe = fs + featLen;
      return fs >= f.start && fe <= end;
    });
    if (!frag) return;

    const upstream = (featStart - frag.start + len) % len;
    const downstream = frag.size - upstream - featLen;
    if (downstream < 0) return;

    // Excess flanking DNA is the thing to minimise — it is what makes the band
    // hard to tell from the backbone. Extra cuts and rarer enzymes are real but
    // secondary costs.
    const excess = upstream + downstream;
    const tightness = featLen / (featLen + excess);          // 1 = perfect
    const simplicity = 1 / (1 + (cuts.length - 2) * 0.15);
    const common = enzymes.reduce((a, e) => a + (e.tier === 1 ? 1 : 0.7), 0) / enzymes.length;
    // Bands within ~10% of each other do not separate; a fragment too close to
    // the rest of the molecule cannot be cut out of the gel in practice.
    const distinct = Math.abs(frag.size - (len - frag.size)) / len > 0.1 ? 1 : 0.4;

    results.push({
      names: enzymes.map((e) => e.name),
      size: frag.size, upstream, downstream, cuts: cuts.length,
      score: tightness * 3 + simplicity * 1 + common * 1 + distinct * 1.5,
    });
  };

  for (const p of usable) consider([p]);
  for (let i = 0; i < usable.length; i++)
    for (let j = i + 1; j < usable.length; j++) consider([usable[i], usable[j]]);

  results.sort((a, b) => b.score - a.score);

  // Different enzyme names producing the same excised fragment are the same
  // experiment; offer distinct outcomes rather than isoschizomer variants.
  const seen = new Set();
  const picked = [];
  for (const r of results) {
    const key = `${r.size}:${r.upstream}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(r);
    if (picked.length >= count) break;
  }
  return picked;
}
