# VIRGE backlog

Open work first, roughly in order of how much it would add; finished items are
summarised at the bottom so the top of this file answers "what is left".

## 1. Buffer activity tables → full double-digest feasibility

**Status:** blocked on data, not on code.

Reaction compatibility currently checks incubation temperature only (see
`bufferWarning()` in `src/enzymes.js`). The missing piece is the per-enzyme
activity matrix — "% activity in NEBuffer r1.1 / r2.1 / r3.1 / rCutSmart" —
which would let VIRGE answer the real bench question: *can I digest with these
two enzymes in one tube, and in which buffer?*

**Why it isn't done:** that matrix is supplier catalog data. It is not in
REBASE, and it was deliberately not guessed — wrong buffer data in a tool
people trust is worse than none.

**To unblock:** supply a supplier activity chart (NEB or Thermo), in any form —
CSV, saved HTML page, or pasted text. Then:

- extend `CATALOG` in `scripts/build-enzymes.mjs` with a `buffers` field per
  enzyme (the build script already passes `meta.buffers` through to the output)
- replace `bufferWarning()` with a "best shared buffer" search: pick the buffer
  maximising the minimum activity across the selected enzymes; if no buffer
  clears a threshold, recommend a sequential digest
- show unknowns as unknown rather than assuming compatibility

## 2. Circular plasmid map

A ring view of the loaded plasmid with cut positions marked per enzyme, beside
the gel. Makes it obvious *where* an enzyme cuts, not just how big the pieces
are. All the data needed is already returned by `findSites()` (site start,
strand, cut coordinates), and GenBank features are drawn as arcs around the
ring — the natural next step now that annotations are loaded and
`featuresCutBy()` already knows which of them a digest hits.

The largest remaining item, and the only one that adds a new rendering surface.

## 3. Partial digest simulation

Model incomplete digestion — a fixed cut probability per site, producing the
partial-digest ladder you actually see when an enzyme under-performs. Useful
for teaching why a gel looks wrong.

**Render it as a distribution, not a lane.** A tube holds ~10⁹ molecules, so a
real partial-digest lane *is* the ensemble: every fragment that any subset of
cut sites can produce, each at the intensity its probability gives it. Drawing
one sampled cut pattern would be a single draw from that ensemble and would
show a different gel on every click — wrong, not merely coarse. For n sites the
enumeration is over the 2ⁿ subsets, so the intensity per size has to be
accumulated analytically (the probability a given fragment survives is the
product over its two ends being cut and its interior sites not being), not by
Monte Carlo. The existing accumulated-intensity profile in `gel.js` already
takes per-size weights, so the renderer needs nothing new.

## 4. Addgene / SnapGene vector import

The common modern vectors (pET-28a, pcDNA3.1, pX330, lentiCRISPRv2, …) have no
usable GenBank deposition, so they cannot be bundled — searching for them is
now answered by the exclusion list in `src/dna-search.js`, which explains why
and points at file import. File import already handles their GenBank exports.
Worth considering: fetching directly from an Addgene plasmid ID, if a stable
public endpoint exists.

## 5. Optional ladder lane

A "show ladder" toggle in Gel Setup, so the gel can be rendered completely
empty. The ladder is already distinguished by brightness, its caption and the
dashed divider — the monochrome palette removed the colour cue it originally
had — which addressed the confusion that prompted this, but being able to drop
it is still reasonable.

## 6. More enzyme metadata

Star activity propensity, heat inactivation conditions, and nicking enzymes
(Nb.BbvCI, Nt.BspQI and friends). Nicking enzymes would need engine work: they
cut one strand only, so they do not produce fragments and would need their own
representation rather than appearing as gel bands.

Star activity is data-blocked in the same way as the buffer tables: it is
supplier annotation, not REBASE.

---

## Done

- **Pulsed-field (CHEF) mode.** A **Field** selector switches between constant
  and pulsed field, with three switch-time programmes (1–6 s / 10–60 s /
  60–120 s) spanning 10 kb to 2.5 Mb, and two pulsed-field standards — λ
  concatemers and S. cerevisiae chromosomes. Inside the window migration is
  linear in size rather than log(size). On E. coli K-12 / NotI (23 fragments,
  4.3 kb to 1.08 Mb) the constant-field gel resolves 2 bands across 27 % of the
  track; 10–60 s resolves 10 across the full track.
- **Feature-aware selection.** Hand-picked enzymes that cut inside an annotated
  gene or origin now warn, naming the features hit, through the same
  `featuresCutBy()` Suggest scores with. **Cut out** proposes enzyme sets that
  flank a chosen feature without cutting inside it — on pBR322, AvaI + HindIII
  takes *tet* off in 1,396 bp.
- **DNA search.** Curated name aliases over the catalog, plus a "deliberately
  absent, and here is why" list, plus NCBI search presented as a picker rather
  than an oracle.
- **Assistant.** Model picker, Markdown and LaTeX rendering (MathML, so the CSP
  needs no `'unsafe-inline'`), and per-request token usage.
- **Gel imaging controls.** Exposure (stops, 0.25×–5.7×) and Contrast (gamma,
  0.25–1.6), saved with configurations, redrawing the gel only so they stay
  responsive on megabase sequences.
- **Lane captions.** Shrink, then stagger onto two rows, then truncate to what
  fits, replacing a fixed 18-character cut.
- **Custom sequences as a saved group.** Imports are kept in "Your sequences"
  with per-item delete and their annotations.
- **A DOM test harness** covering the wiring between the science and the page,
  which is where every reported bug has actually lived.
