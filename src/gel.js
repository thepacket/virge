// Virtual agarose gel renderer (canvas).
// Migration distance is modeled as linear in log10(bp) between the resolving
// range of the chosen agarose percentage; bands clamp (compress) outside it.

export const LADDERS = {
  "1kb":   { label: "1 kb ladder",   sizes: [10000, 8000, 6000, 5000, 4000, 3000, 2500, 2000, 1500, 1000, 750, 500, 250] },
  "100bp": { label: "100 bp ladder", sizes: [1500, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100] },
};

// Resolving range [min bp, max bp] by agarose %
const RANGES = { 0.7: [500, 20000], 1: [250, 12000], 1.5: [120, 5000], 2: [80, 3000] };

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

export function renderGel(canvas, lanes, opts) {
  const { gelPct = 1, ladderKey = "1kb", exposure = 1, contrast = 0.5 } = opts;
  // The agarose % sets the physical resolving limits; the chosen ladder frames
  // the visible size window inside them, so switching ladders rescales the
  // whole gel (every lane), not just the ladder lane.
  const [gelMin, gelMax] = RANGES[gelPct] || RANGES[1];
  const ladderSizes = LADDERS[ladderKey].sizes;
  const maxBp = Math.min(gelMax, Math.max(...ladderSizes) * 1.5);
  const minBp = Math.max(gelMin, Math.min(...ladderSizes) / 1.5);
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
  ctx.fillRect(56, 8, W - 64, H - 16);

  const allLanes = [{ ladder: true, label: LADDERS[ladderKey].label }, ...lanes];
  const laneW = (W - 150) / Math.max(allLanes.length, 5);
  const bandWidth = Math.min(laneW * 0.56, 120);
  const wellY = 40, trackTop = 58, trackBottom = H - 36;

  // Linear in log(bp) inside the resolving range; outside it, migration is
  // compressed (slope ×0.12) rather than clamped, so out-of-range fragments
  // still separate slightly and stack near the top/bottom like on a real gel.
  const trackH = trackBottom - trackTop;
  const yFor = (bp) => {
    let t = (Math.log10(maxBp) - Math.log10(bp)) / (Math.log10(maxBp) - Math.log10(minBp));
    if (t < 0) t = Math.max(t * 0.12, -12 / trackH);
    else if (t > 1) t = 1 + Math.min((t - 1) * 0.12, 24 / trackH);
    return trackTop + t * trackH;
  };

  allLanes.forEach((lane, i) => {
    const x = 110 + (i + 0.5) * laneW;

    // well
    ctx.fillStyle = ink(GEL.well);
    ctx.fillRect(x - bandWidth / 2, wellY - 8, bandWidth, 10);

    // label
    ctx.save();
    ctx.fillStyle = ink(lane.ladder ? GEL.ladderLabel : GEL.laneLabel);
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    const label = lane.label.length > 18 ? lane.label.slice(0, 17) + "…" : lane.label;
    ctx.fillText(label, x, lane.ladder ? 18 : 22);
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
        const txt = s >= 1000 ? (s / 1000).toFixed(s % 1000 ? 1 : 0) + " kb" : s + " bp";
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
  const dividerX = 110 + laneW;
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
}
