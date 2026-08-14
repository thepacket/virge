// Virtual gel renderer (canvas), covering two electrophoresis regimes.
//
// Constant-field agarose: migration is linear in log10(bp) across the resolving
// range of the chosen agarose percentage, which is why it runs out above ~20 kb
// — every larger fragment reaches the same limiting mobility and piles into one
// band at the top.
//
// Pulsed-field (CHEF): the field periodically changes direction, so a molecule
// has to reorient before it can move again, and the time that takes scales with
// its length. Above the constant-field limit that restores size dependence, out
// to megabases. Two consequences are modelled here: the resolving window is set
// by the switch time rather than the agarose percentage, and inside that window
// migration is roughly linear in *size* rather than in log(size) — which is the
// property that makes a ramped-pulse gel readable, and why the ladder spacing
// looks so different between the two modes.
//
// Neither is a physical simulation. Both are resolving-window models: the
// window comes from published protocol ranges, and behaviour outside it is the
// same compression used everywhere else in this file.

export const LADDERS = {
  "1kb":   { label: "1 kb ladder",   sizes: [10000, 8000, 6000, 5000, 4000, 3000, 2500, 2000, 1500, 1000, 750, 500, 250] },
  "100bp": { label: "100 bp ladder", sizes: [1500, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100] },

  // λ cI857 Sam7 is 48,502 bp; the PFG marker is a concatemer series of it, so
  // every rung is an exact multiple and the sizes need no external source.
  "lambda-pfg": {
    label: "λ ladder (PFG)", mode: "pfge",
    sizes: Array.from({ length: 21 }, (_, i) => 48502 * (21 - i)),
  },
  // S. cerevisiae S288C reference chromosome lengths. Chromosome I here is
  // 230,218 bp — the same number as the bundled Yeast chromosome I sample, so
  // the ladder and the sample agree by construction rather than by luck.
  //
  // Caveat worth knowing at the bench: chromosome XII runs at ~2.2 Mb on a real
  // gel, not the 1,078 kb below. The assembly collapses its ~150-copy rDNA
  // array; the physical molecule keeps it. The assembly value is used because
  // it is the one that is verifiable.
  "yeast-chr": {
    label: "S. cerevisiae chromosomes", mode: "pfge",
    sizes: [1531933, 1091291, 1090940, 1078177, 948066, 924431, 813184, 784333,
            745751, 666816, 576874, 562643, 439888, 316620, 270161, 230218],
  },
};

// Resolving range [min bp, max bp] by agarose %
const RANGES = { 0.7: [500, 20000], 1: [250, 12000], 1.5: [120, 5000], 2: [80, 3000] };

// Pulsed-field programmes. The switch time is what an operator actually dials
// in; the range is the window that programme resolves. Representative CHEF
// conditions (1% agarose, 0.5x TBE, 6 V/cm, 120 degrees, 14 C) — the run times
// are there because a PFGE run is a day of the week, not an afternoon, and that
// is a real part of choosing this technique.
export const PFGE_RUNS = {
  short:  { label: "1–6 s · 10–150 kb",   switchTime: "1–6 s",   hours: 20, range: [10000, 150000] },
  medium: { label: "10–60 s · 0.1–1 Mb",  switchTime: "10–60 s", hours: 22, range: [100000, 1000000] },
  long:   { label: "60–120 s · 0.2–2.5 Mb", switchTime: "60–120 s", hours: 24, range: [200000, 2500000] },
};

/** bp / kb / Mb, whichever keeps the number short. A PFGE ladder rung is
 *  1,531,933 bp, which nobody reads as a number and everybody reads as 1.5 Mb. */
export function sizeLabel(bp) {
  // Trailing zero stripped only in the decimal branch — doing it unconditionally
  // turns "10 Mb" into "1 Mb".
  if (bp >= 1e6) {
    return (bp % 1e6 ? (bp / 1e6).toFixed(2).replace(/0$/, "") : String(bp / 1e6)) + " Mb";
  }
  if (bp >= 1000) return (bp / 1000).toFixed(bp % 1000 ? 1 : 0) + " kb";
  return bp + " bp";
}

/** Ladder keys valid in a given mode. */
export const laddersFor = (mode) =>
  Object.entries(LADDERS)
    .filter(([, l]) => (l.mode || "agarose") === mode)
    .map(([k, l]) => [k, l.label]);

// ---------------------------------------------------------------------------
// Monochrome palette — the look of a gel photographed on a gel doc, where the
// image is a single channel and nothing is colour-coded.
//
// Losing hue means the ladder and the sample lanes can no longer be told apart
// by colour, so they are separated by BRIGHTNESS instead: sample bands print at
// full strength and the ladder deliberately dimmer, which is also how a
// mass-adjusted ladder actually exposes next to a concentrated digest. The
// ladder additionally keeps its caption and the dashed divider, so the cue is
// not carried by tone alone.
//
// TINT is the single hue everything derives from — set it to [255,255,255] for
// a neutral grey gel, or something like [176,226,255] to tint it cool.
const TINT = [255, 255, 255];

/** `r,g,b` at a fraction of full strength, for interpolating into rgba(). */
const tone = (level) => TINT.map((c) => Math.round(c * level)).join(",");
/** A complete rgba() colour at a fraction of full strength. */
const ink = (level, alpha = 1) => `rgba(${tone(level)},${alpha})`;

// Every value is a fraction of TINT, surfaces included — so the gel is a single
// hue throughout and changing TINT retints all of it consistently. (Deriving the
// surfaces mattered: hand-written hex values for them carried a faint blue cast,
// which left the "monochrome" gel quietly two-toned.)
const GEL = {
  backdropTop: 0.065,       // the stage the slab sits on
  backdropBottom: 0.035,
  slab: 0.085,              // the agarose itself
  well: 0.02,
  divider: 0.18,
  laneLabel: 0.86,          // sample lane captions
  ladderLabel: 0.56,        // ladder caption + "size standard" note
  sizeLabel: 0.52,          // the ladder's bp labels
  hint: 0.42,               // empty-state text
  sampleBand: 1.0,          // full strength
  ladderBand: 0.62,         // dimmer, so the reference reads as reference
};

// Horizontal geometry, in CSS pixels.
//
// The slab runs the full width of the canvas — there is no backdrop margin at
// the left or right edge. It used to inset by 56px to hold the "− wells" and
// "+" electrode marks; those are gone, so nothing needs the space.
//
// LANE_LEFT is not margin, it is clearance: the ladder's bp labels are drawn
// right-aligned off the left edge of its band, so the first lane centre has to
// sit far enough in that the widest label ("1.5 kb") still starts on canvas.
// LANE_RIGHT is the matching clearance for the last lane's caption, which is
// centred on the lane and would otherwise overhang.
const LANE_LEFT = 70;
const LANE_RIGHT = 40;

/** The visible size window: the programme's resolving range, narrowed to the
 *  ladder actually loaded.
 *
 *  The two can fail to overlap — the 1–6 s pulse programme resolves 10–150 kb
 *  and the smallest yeast chromosome is 230 kb, a pairing the UI can reach — and
 *  the intersection then inverts. Left alone that produced a negative axis span:
 *  no error, just a gel with every band stacked on the bottom edge, which is how
 *  this went unnoticed while the mode itself was mis-wired. When they do not
 *  overlap the ladder wins, because a gel you cannot read against its own size
 *  standard is useless whatever the programme says. */
export function sizeWindow(gelMin, gelMax, ladderSizes) {
  const lo = Math.min(...ladderSizes), hi = Math.max(...ladderSizes);
  const minBp = Math.max(gelMin, lo / 1.5);
  const maxBp = Math.min(gelMax, hi * 1.5);
  return minBp < maxBp ? [minBp, maxBp] : [lo / 1.5, hi * 1.5];
}

export function renderGel(canvas, lanes, opts) {
  const { gelPct = 1, ladderKey = "1kb", exposure = 1, contrast = 0.5,
          gelMode = "agarose", pfgeRun = "medium" } = opts;
  // The programme sets the physical resolving limits — agarose % under a
  // constant field, switch time under a pulsed one. The chosen ladder frames
  // the visible size window inside them, so switching ladders rescales the
  // whole gel (every lane), not just the ladder lane.
  const pfge = gelMode === "pfge";
  const [gelMin, gelMax] = pfge
    ? (PFGE_RUNS[pfgeRun] || PFGE_RUNS.medium).range
    : (RANGES[gelPct] || RANGES[1]);
  const ladderSizes = LADDERS[ladderKey].sizes;
  const [minBp, maxBp] = sizeWindow(gelMin, gelMax, ladderSizes);
  const ctx = canvas.getContext("2d");
  // Size the bitmap to the element's CSS box, scaled for the device pixel
  // ratio, so the gel stays crisp at any window width.
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 760, H = canvas.clientHeight || 560;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // --- gel slab background ---
  ctx.clearRect(0, 0, W, H);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, ink(GEL.backdropTop));
  bg.addColorStop(1, ink(GEL.backdropBottom));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = ink(GEL.slab);
  ctx.fillRect(0, 8, W, H - 16);

  const allLanes = [{ ladder: true, label: LADDERS[ladderKey].label }, ...lanes];
  const laneW = (W - LANE_LEFT - LANE_RIGHT) / Math.max(allLanes.length, 5);
  const bandWidth = Math.min(laneW * 0.56, 120);
  const wellY = 40, trackTop = 58, trackBottom = H - 36;

  // Position inside the resolving range: linear in log(bp) under a constant
  // field, linear in bp under a pulsed one. That difference is the whole point
  // of the mode — a log scale crushes 1 Mb and 2 Mb together, and a ramped
  // pulse programme is chosen precisely so it does not.
  //
  // Outside the range, migration is compressed (slope ×0.12) rather than
  // clamped, so out-of-range fragments still separate slightly and stack near
  // the top/bottom like on a real gel.
  const trackH = trackBottom - trackTop;
  const span = pfge
    ? (bp) => (maxBp - bp) / (maxBp - minBp)
    : (bp) => (Math.log10(maxBp) - Math.log10(bp)) / (Math.log10(maxBp) - Math.log10(minBp));
  const yFor = (bp) => {
    let t = span(bp);
    if (t < 0) t = Math.max(t * 0.12, -12 / trackH);
    else if (t > 1) t = 1 + Math.min((t - 1) * 0.12, 24 / trackH);
    return trackTop + t * trackH;
  };

  // Lane captions are centred above their lane and collide once the lane is
  // narrower than the text — reachable on a laptop since the three-column
  // layout, not just on a phone. Three steps, cheapest first: shrink the font,
  // then stagger onto two rows (which doubles the room a caption has before it
  // meets its same-row neighbour), then truncate to what actually fits. The old
  // fixed 18-character cut did none of this: it truncated "EcoRI + HindIII"
  // never, and let it overlap at any width.
  const CAPTION_SIZES = [11, 10, 9];
  const captionWidth = (text, size) => {
    ctx.font = `${size}px system-ui, sans-serif`;
    return ctx.measureText(text).width;
  };
  const fitCaption = (text, room) => {
    for (const size of CAPTION_SIZES) {
      if (captionWidth(text, size) <= room) return { text, size };
    }
    const size = CAPTION_SIZES[CAPTION_SIZES.length - 1];
    let cut = text;
    while (cut.length > 1 && captionWidth(cut + "…", size) > room) cut = cut.slice(0, -1);
    return { text: cut + "…", size };
  };
  // Staggering is all-or-nothing: alternating only some lanes reads as an
  // alignment bug rather than a layout.
  const smallest = CAPTION_SIZES[CAPTION_SIZES.length - 1];
  const stagger = allLanes.slice(1)
    .some((l) => captionWidth(l.label, smallest) > laneW - 6);

  allLanes.forEach((lane, i) => {
    const x = LANE_LEFT + (i + 0.5) * laneW;

    // well
    ctx.fillStyle = ink(GEL.well);
    ctx.fillRect(x - bandWidth / 2, wellY - 8, bandWidth, 10);

    // label
    ctx.save();
    ctx.fillStyle = ink(lane.ladder ? GEL.ladderLabel : GEL.laneLabel);
    ctx.textAlign = "center";
    // The ladder sits alone left of the divider, so it never staggers and only
    // ever competes with itself.
    const room = lane.ladder || !stagger ? laneW - 6 : 2 * laneW - 10;
    const caption = fitCaption(lane.label, room);
    ctx.font = `${caption.size}px system-ui, sans-serif`;
    const y = lane.ladder ? 18 : stagger ? (i % 2 ? 16 : 27) : 22;
    ctx.fillText(caption.text, x, y);
    if (lane.ladder) {
      // Spell out that this lane is the reference ruler, not a digest.
      ctx.fillStyle = ink(GEL.ladderLabel, 0.85);
      ctx.font = "italic 9px system-ui, sans-serif";
      ctx.fillText("size standard — not a digest", x, 29);
    }
    ctx.restore();

    const sizes = lane.ladder
      ? LADDERS[ladderKey].sizes.map((s) => ({ size: s }))
      : lane.fragments;
    if (!sizes || sizes.length === 0) return;

    // Accumulate stain into a per-row intensity profile rather than drawing one
    // opaque rectangle per fragment. Overlapping fragments then *add up* like
    // real stained DNA, so a handful of fragments give sharp bands and hundreds
    // give a smear with visible density structure — instead of hundreds of
    // rectangles overdrawing into a solid block.
    const trackH = Math.max(1, Math.round(trackBottom - trackTop));
    const rows = new Float32Array(trackH + 1);

    for (const f of sizes) {
      // Fragments too large or too small to resolve pile into the compression
      // zones at the ends of the gel rather than vanishing off the track.
      const y = Math.max(0, Math.min(trackH, yFor(f.size) - trackTop));
      // Ethidium/SYBR signal is proportional to the mass of DNA in the band.
      // Fragments of one digest are equimolar, so mass scales with length.
      // Ladder bands are mass-adjusted by the manufacturer to look even.
      const mass = lane.ladder ? 1 : f.size;
      // Smaller fragments diffuse more, so their bands are broader and softer.
      const sigma = Math.max(0.9, 3.2 - 0.55 * Math.log10(Math.max(f.size, 10)));
      const lo = Math.max(0, Math.floor(y - 3 * sigma));
      const hi = Math.min(trackH, Math.ceil(y + 3 * sigma));
      for (let i = lo; i <= hi; i++) {
        const d = (i - y) / sigma;
        rows[i] += mass * Math.exp(-0.5 * d * d);
      }
    }

    // Scale to a high percentile of the occupied rows rather than the absolute
    // peak, and let anything brighter clip. This is what a gel doc's exposure
    // does: a genomic digest's compression zone holds most of the mass and
    // burns out white, while the smear below it stays readable. Normalising to
    // the peak instead would render everything else nearly black.
    const occupied = [];
    for (const v of rows) if (v > 0) occupied.push(v);
    if (occupied.length === 0) return;
    occupied.sort((a, b) => a - b);
    // `exposure` shifts that reference the way a longer or shorter exposure
    // would: >1 brightens (faint bands emerge, bright ones burn out), <1 darkens
    // (a saturated compression zone resolves into structure).
    const pct = occupied[Math.floor(0.75 * (occupied.length - 1))] || occupied[occupied.length - 1];
    const ref = pct / exposure;
    if (ref <= 0) return;

    // Gamma-compress so faint smear detail stays visible next to a bright band,
    // the way a gel doc's exposure does.
    // Uncut plasmid prints at sample strength — it is DNA, and its "uncut"
    // caption below carries the distinction that orange used to.
    const rgb = tone(lane.ladder ? GEL.ladderBand : GEL.sampleBand);
    const left = x - bandWidth / 2;
    ctx.save();
    // Wide, faint pass first: the fluorescent halo around a stained band.
    // `contrast` is the gamma of the transfer curve: a low exponent flattens
    // everything toward mid-brightness so faint detail survives, a high one
    // steepens it so only strong signal registers. The halo is drawn a little
    // flatter than the core so it stays a glow rather than a hard outline.
    const gamma = Math.max(0.05, contrast);
    for (let i = 0; i <= trackH; i++) {
      const v = rows[i] / ref;
      if (v < 0.03) continue;
      const a = Math.min(1, Math.pow(v, gamma * 1.1));
      ctx.fillStyle = `rgba(${rgb},${(a * 0.22).toFixed(3)})`;
      ctx.fillRect(left - 4, trackTop + i, bandWidth + 8, 1);
    }
    for (let i = 0; i <= trackH; i++) {
      const v = rows[i] / ref;
      if (v < 0.025) continue;
      const a = Math.min(1, Math.pow(v, gamma) * 0.95);
      ctx.fillStyle = `rgba(${rgb},${a.toFixed(3)})`;
      ctx.fillRect(left, trackTop + i, bandWidth, 1);
    }
    ctx.restore();

    // ladder size labels
    if (lane.ladder) {
      ctx.fillStyle = ink(GEL.sizeLabel);
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "right";
      let lastLabelY = -Infinity;
      for (const s of LADDERS[ladderKey].sizes) {
        const y = yFor(s);
        if (y - lastLabelY < 11) continue; // skip labels that would overlap
        lastLabelY = y;
        const txt = sizeLabel(s);
        ctx.fillText(txt, x - bandWidth / 2 - 8, y + 3);
      }
    }

    // uncut annotation
    if (lane.uncut) {
      ctx.fillStyle = ink(0.72, 0.9);
      ctx.font = "italic 10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("uncut", x, yFor(sizes[0].size) + 16);
    }
  });

  // Divider between the reference ladder and the sample lanes.
  const dividerX = LANE_LEFT + laneW;
  ctx.save();
  ctx.strokeStyle = ink(GEL.divider);
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(dividerX, 34);
  ctx.lineTo(dividerX, H - 14);
  ctx.stroke();
  ctx.restore();

  if (lanes.length === 0) {
    const cx = (dividerX + W) / 2;
    ctx.fillStyle = ink(GEL.hint);
    ctx.textAlign = "center";
    ctx.font = "italic 13px system-ui, sans-serif";
    ctx.fillText("No digest lanes on this gel", cx, H / 2 - 8);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText("Select enzymes at left and click “Add lane with selection”,", cx, H / 2 + 12);
    ctx.fillText("or press ✨ Suggest. The lane at left is the size ladder.", cx, H / 2 + 27);
  }

  // Run conditions, so a saved PNG still says how the gel was run. Without it a
  // pulsed-field image is indistinguishable from a constant-field one that has
  // simply been given a strange ladder.
  const run = PFGE_RUNS[pfgeRun] || PFGE_RUNS.medium;
  ctx.fillStyle = ink(GEL.hint, 0.75);
  ctx.font = "9px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(
    pfge
      ? `CHEF pulsed-field · 1% agarose · ${run.switchTime} switch · ${run.hours} h`
      : `${gelPct.toFixed(1)}% agarose · constant field`,
    6, H - 13);
}
