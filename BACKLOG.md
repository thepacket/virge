# VIRGE backlog

Deferred work, roughly in order of how much it would add.

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
strand, cut coordinates), and GenBank features are now available to draw as
arcs around the ring — this is the natural next step now that annotations are
loaded.

## 2b. Feature-aware selection helpers

With annotations in hand: "cut out this feature" (propose enzyme pairs flanking
a chosen gene without cutting inside it), and warn when a selected enzyme cuts
*within* a named feature — the standard "will this destroy my insert?" check.

## 3. Partial digest simulation

Model incomplete digestion — a fixed cut probability per site, producing the
partial-digest ladder you actually see when an enzyme under-performs. Useful
for teaching why a gel looks wrong.

## ~~4. Custom sequences as a saved group~~ — done

Imports are now kept in a "Your sequences" group with per-item delete, and
carry their annotations. Superseded by the wider DNA-source work (file drop,
accession fetch, GenBank parsing).

## ~~4a. Gel imaging controls~~ — done

Exposure (stops, 0.25×–5.7×) and Contrast (gamma, 0.25–1.6) sliders in Gel
Setup. Double-click either to reset; both are saved with configurations and
redraw the gel only (digests are cached), so they stay responsive on megabase
sequences.

## 4b. Pulsed-field gel mode

Genomes are now loadable, and rare-cutter digests of them produce megabase
fragments that all pile up at the top of a normal agarose gel — correctly, but
uninformatively. A PFGE mode (different migration model, a lambda-ladder /
yeast-chromosome size standard) would make E. coli NotI digests readable, which
is the actual experiment those fragments come from.

## 4c. Addgene / SnapGene vector import

The common modern vectors (pET-28a, pcDNA3.1, pX330, lentiCRISPRv2, …) have no
usable GenBank deposition, so they cannot be bundled. File import already
handles their GenBank exports. Worth considering: fetching directly from an
Addgene plasmid ID, if a stable public endpoint exists.

## 5. Optional ladder lane

A "show ladder" toggle in Gel Setup, so the gel can be rendered completely
empty. The ladder is now visually distinct (blue, captioned, divided off), which
addressed the original confusion, but being able to drop it is still reasonable.

## 6. More enzyme metadata

Star activity propensity, heat inactivation conditions, and nicking enzymes
(Nb.BbvCI, Nt.BspQI and friends). Nicking enzymes would need engine work: they
cut one strand only, so they do not produce fragments and would need their own
representation rather than appearing as gel bands.
