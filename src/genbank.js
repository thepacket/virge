// Parsers for the file formats people actually have sequences in:
// GenBank flat files (.gb/.gbk — what SnapGene, Benchling and NCBI export)
// and FASTA, including multi-record files.
//
// Used both at build time (scripts/build-samples.mjs) and in the browser for
// uploads, so the two paths cannot drift apart.

/** Parse a GenBank location string into 0-based half-open segments. */
export function parseLocation(loc) {
  const complement = /^complement\(/.test(loc);
  // Strip complement()/join()/order() wrappers; we keep only the spans.
  const inner = loc.replace(/^(complement|join|order)\(/g, "").replace(/\)+$/g, "");
  const segments = [];
  for (const part of inner.split(",")) {
    const m = part.trim().match(/^[<>]?(\d+)(?:\.\.[<>]?(\d+))?$/);
    if (!m) continue;
    const start = parseInt(m[1], 10) - 1;          // GenBank is 1-based inclusive
    const end = m[2] ? parseInt(m[2], 10) : start + 1;
    if (end > start) segments.push({ start, end });
  }
  return { segments, strand: complement ? -1 : 1 };
}

// Features that describe the whole molecule rather than a region of interest.
const SKIP_FEATURES = new Set(["source"]);

/** Parse a GenBank flat file. Returns null if it doesn't look like one. */
export function parseGenBank(text) {
  const locus = text.match(/^LOCUS\s+(\S+)\s+(\d+)\s+bp(.*)$/m);
  if (!locus) return null;

  const [, locusName, , locusRest] = locus;
  const definition = (text.match(/^DEFINITION\s+([\s\S]*?)(?=^\S)/m)?.[1] || "")
    .replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const version = text.match(/^VERSION\s+(\S+)/m)?.[1] || "";
  // The LOCUS line states topology; trust it rather than guessing.
  const circular = /\bcircular\b/i.test(locusRest);
  // …and the molecule type, which decides whether a restriction digest is even
  // a real experiment. Restriction endonucleases need a DNA duplex: they do not
  // cut RNA at all, and a single strand has no second strand to nick. Recorded
  // rather than acted on here — the parser's job is to report what the file
  // says — but scripts/build-samples.mjs refuses to bundle anything but dsDNA,
  // which is how an RNA virus stopped being offered as a digestible sample.
  const moltype = (locusRest.match(/\b(ss-DNA|ds-DNA|ss-RNA|ds-RNA|ms-DNA|mRNA|cRNA|RNA|DNA)\b/i)?.[1] || "")
    .toUpperCase();

  const originIdx = text.search(/^ORIGIN/m);
  if (originIdx === -1) return null;
  const sequence = text.slice(originIdx)
    .replace(/^ORIGIN.*$/m, "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
  if (!sequence) return null;

  // --- FEATURES table ---
  const features = [];
  const featIdx = text.search(/^FEATURES/m);
  if (featIdx !== -1 && featIdx < originIdx) {
    const block = text.slice(featIdx, originIdx).split("\n").slice(1);
    let cur = null;
    const flush = () => {
      if (!cur || SKIP_FEATURES.has(cur.type)) return;
      const { segments, strand } = parseLocation(cur.location);
      if (segments.length === 0) return;
      const label = cur.qualifiers.label || cur.qualifiers.gene ||
                    cur.qualifiers.product || cur.qualifiers.note ||
                    cur.qualifiers.standard_name || cur.type;
      features.push({
        type: cur.type,
        label: label.length > 40 ? label.slice(0, 39) + "…" : label,
        strand,
        start: Math.min(...segments.map((s) => s.start)),
        end: Math.max(...segments.map((s) => s.end)),
        segments,
      });
    };

    for (const line of block) {
      const featStart = line.match(/^ {5}(\S+)\s+(\S.*)$/);
      const qual = line.match(/^ {21}\/(\w+)(?:=(.*))?$/);
      if (featStart) {
        flush();
        cur = { type: featStart[1], location: featStart[2].trim(), qualifiers: {}, lastQual: null };
      } else if (!cur) {
        continue;
      } else if (qual) {
        const key = qual[1];
        const val = (qual[2] || "").replace(/^"|"$/g, "");
        cur.qualifiers[key] = val;
        cur.lastQual = key;
      } else if (/^ {21}\S/.test(line)) {
        // Continuation: either a wrapped location or a wrapped qualifier value.
        const cont = line.trim().replace(/"$/, "");
        if (cur.lastQual) cur.qualifiers[cur.lastQual] += " " + cont;
        else cur.location += cont;
      }
    }
    flush();
  }

  return {
    name: definition || locusName,
    accession: version,
    circular,
    moltype,
    sequence,
    features,
  };
}

/** Parse FASTA, including multi-record files. Returns [] if not FASTA. */
export function parseFasta(text) {
  if (!/^\s*>/.test(text)) return [];
  const records = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith(">")) {
      if (cur) records.push(cur);
      const header = line.slice(1).trim();
      cur = { name: header.split(/\s+/).slice(1).join(" ") || header.split(/\s+/)[0] || "sequence",
              accession: header.split(/\s+/)[0] || "", sequence: "", features: [], circular: null };
    } else if (cur) {
      cur.sequence += line.replace(/[^A-Za-z]/g, "").toUpperCase();
    }
  }
  if (cur) records.push(cur);
  return records.filter((r) => r.sequence.length > 0);
}

export class ParseError extends Error {}

/**
 * Parse whatever the user gave us: GenBank, FASTA, or bare sequence.
 * Returns an array of records so multi-record files can be offered as a choice.
 * Throws ParseError rather than guessing when the input is a recognisable
 * format that cannot be read — scraping letters out of a GenBank file's prose
 * yields a plausible-looking sequence that is entirely wrong.
 */
export function parseAny(text, fallbackName = "pasted sequence") {
  if (/^LOCUS\s/m.test(text)) {
    const gb = parseGenBank(text);
    if (gb) return [gb];
    if (/^CONTIG\s/m.test(text)) {
      throw new ParseError(
        "this GenBank record has no sequence — it is a CON (contig) entry that " +
        "points at another accession. Re-fetch it with the full sequence included."
      );
    }
    throw new ParseError("looks like GenBank, but no ORIGIN sequence block was found.");
  }

  const fa = parseFasta(text);
  if (fa.length) return fa;

  const seq = text.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (!seq) return [];
  // A bare sequence should be overwhelmingly DNA; if it isn't, this is some
  // other kind of file and we should say so rather than digest gibberish.
  const dna = (seq.match(/[ACGTNRYSWKMBDHV]/g) || []).length;
  if (dna / seq.length < 0.9) {
    throw new ParseError("this doesn't look like DNA — expected a GenBank, FASTA, or raw sequence file.");
  }
  return [{ name: fallbackName, accession: "", sequence: seq, features: [], circular: null }];
}

/** Sequence composition, for the "does this look right?" check. */
export function sequenceStats(seq) {
  let gc = 0, ambiguous = 0;
  for (const c of seq) {
    if (c === "G" || c === "C") gc++;
    else if (c !== "A" && c !== "T") ambiguous++;
  }
  return {
    length: seq.length,
    gc: seq.length ? (gc / seq.length) * 100 : 0,
    ambiguous,
  };
}

// Cutting through one of these breaks something the user probably cares about.
export const PROTECTED_FEATURES = new Set(["CDS", "gene", "rep_origin"]);

/**
 * Which protected features each cut position lands inside.
 *
 * Returns `[{ label, type, cuts: [pos, ...] }]`, one entry per feature hit,
 * in sequence order. Suggest reduces this to a fraction for scoring while the
 * enzyme panel names the genes; both go through here so the automated and the
 * manual path can never disagree about what counts as cutting a gene.
 */
export function featuresCutBy(cuts, features) {
  if (!features?.length || !cuts.length) return [];
  const hits = [];
  for (const f of features) {
    if (!PROTECTED_FEATURES.has(f.type)) continue;
    const inside = cuts.filter((c) => f.segments.some((s) => c >= s.start && c < s.end));
    if (inside.length) hits.push({ label: f.label, type: f.type, cuts: inside });
  }
  return hits.sort((a, b) => a.cuts[0] - b.cuts[0]);
}

/** Features overlapping a fragment, for circular-aware fragment annotation. */
export function featuresInRange(features, start, end, seqLen, circular) {
  const spans = end > start ? [[start, end]] : [[start, seqLen], [0, end]];
  return features.filter((f) =>
    f.segments.some((s) => spans.some(([a, b]) => s.start < b && a < s.end))
  );
}
