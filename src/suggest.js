// Suggest interesting digests for the loaded DNA: single and double digests
// scored for band count, spread, and how much of the pattern falls in the
// gel's resolvable range.
import { ENZYMES } from "./enzymes.js";
import { findCuts, fragmentsFromCuts } from "./digest.js";

function scoreSizes(sizes, minBp, maxBp) {
  const n = sizes.length;
  if (n < 3 || n > 14) return -Infinity;
  const logs = sizes.map((s) => Math.log10(s)).sort((a, b) => a - b);
  let distinct = 1;
  for (let i = 1; i < logs.length; i++) if (logs[i] - logs[i - 1] > 0.04) distinct++;
  const inRange = sizes.filter((s) => s >= minBp && s <= maxBp).length / n;
  const span = Math.min(logs[n - 1] - logs[0], 2);
  return distinct * 2 + inRange * 4 + span * 2 - Math.abs(n - 7) * 0.3;
}

// Returns up to `count` enzyme-name sets, best first, skipping any set already
// present in `existing` (array of sorted-name keys).
export function suggestDigests(seq, circular, { minBp = 150, maxBp = 20000, count = 3, existing = [], methylation = "none", maxTier = 2 } = {}) {
  const len = seq.length;
  const cutsByEnzyme = new Map();
  // Only propose enzymes a lab would actually reach for, and keep the pairwise
  // search tractable now that the catalog runs to a couple of hundred.
  for (const e of ENZYMES) {
    if (e.tier > maxTier) continue;
    const cuts = findCuts(seq, e, circular, methylation);
    if (cuts.length > 0 && cuts.length <= 20) cutsByEnzyme.set(e.name, cuts);
  }
  const cutters = [...cutsByEnzyme.keys()];
  const candidates = [];

  const evaluate = (names) => {
    const merged = [...new Set(names.flatMap((n) => cutsByEnzyme.get(n)))].sort((a, b) => a - b);
    const sizes = fragmentsFromCuts(merged, len, circular).map((f) => f.size);
    const score = scoreSizes(sizes, minBp, maxBp);
    if (score > -Infinity) candidates.push({ names, score, bands: sizes.length });
  };

  for (const n of cutters) evaluate([n]);
  for (let i = 0; i < cutters.length; i++)
    for (let j = i + 1; j < cutters.length; j++) evaluate([cutters[i], cutters[j]]);

  candidates.sort((a, b) => b.score - a.score);

  const existingKeys = new Set(existing);
  const picked = [];
  const usedLead = new Set();
  for (const c of candidates) {
    const key = [...c.names].sort().join("+");
    if (existingKeys.has(key)) continue;
    // diversity: avoid three suggestions all led by the same enzyme
    const lead = c.names[0];
    if (usedLead.has(lead) && picked.length > 0) continue;
    picked.push(c.names);
    existingKeys.add(key);
    usedLead.add(lead);
    if (picked.length >= count) break;
  }
  return picked;
}
