// Builds src/data/enzymes.js from the REBASE bionet file.
//
// REBASE (http://rebase.neb.com) is the authoritative restriction enzyme
// database, copyright Dr. Richard J. Roberts — free for academic use.
// We take recognition sites and cut coordinates from it, and merge in the
// hand-curated practical metadata REBASE does not carry (incubation
// temperature, Dam/Dcm sensitivity, how commonly the enzyme is used).
//
// Usage: node scripts/build-enzymes.mjs
import fs from "node:fs";

const SRC = "data-src/rebase_bairoch.txt";
const SRC_URL = "http://rebase.neb.com/rebase/link_bairoch";
const OUT = "src/data/enzymes.js";

// REBASE commercial-source codes (from the file's own header).
const SUPPLIERS = {
  B: "Thermo Fisher", E: "Agilent", I: "SibEnzyme", J: "Nippon Gene",
  K: "Takara", M: "Roche", N: "NEB", O: "Toyobo", Q: "CHIMERx",
  R: "Promega", S: "Sigma", V: "Vivantis", X: "EURx",
};

// ---------------------------------------------------------------------------
// Curated catalog: the enzymes worth having, with metadata REBASE lacks.
//   tier 1 = everyday workhorse, 2 = commonly stocked, 3 = specialist
//   temp   = incubation °C (omitted means 37)
//   dam/dcm = "blocked" | "required"  (only when the site can overlap the
//             methylase target; absent means insensitive)
// ---------------------------------------------------------------------------
const CATALOG = {
  // ---- Type IIP: classic 6-cutters -----------------------------------------
  AatII: { tier: 2 }, Acc65I: { tier: 2 }, AclI: { tier: 3 }, AfeI: { tier: 3 },
  AflII: { tier: 2 }, AflIII: { tier: 3 }, AgeI: { tier: 1 }, AhdI: { tier: 3 },
  AleI: { tier: 3 }, AlwNI: { tier: 3 }, ApaI: { tier: 1, temp: 25 },
  ApaLI: { tier: 2 }, AscI: { tier: 1 }, AseI: { tier: 2 }, AsiSI: { tier: 2 },
  AvaI: { tier: 2 }, AvrII: { tier: 1 }, BaeGI: { tier: 3 }, BamHI: { tier: 1 },
  BanI: { tier: 3 }, BanII: { tier: 3 }, BbvCI: { tier: 3 }, BclI: { tier: 2, temp: 50, dam: "blocked" },
  BglI: { tier: 3 }, BglII: { tier: 1 }, BlpI: { tier: 3 }, BmtI: { tier: 3 },
  BsaAI: { tier: 3 }, BsaBI: { tier: 3, temp: 60, dam: "blocked" }, BsaHI: { tier: 3 },
  BsaJI: { tier: 3 }, BsaWI: { tier: 3 }, BsiEI: { tier: 3 }, BsiHKAI: { tier: 3 },
  BsiWI: { tier: 2 }, BsmI: { tier: 3, temp: 65 }, BsoBI: { tier: 3 },
  BspDI: { tier: 3, dam: "blocked" }, BspEI: { tier: 2, dam: "blocked" },
  BspHI: { tier: 2, dam: "blocked" }, BspQI: { tier: 2, temp: 50 },
  BsrBI: { tier: 3 }, BsrFI: { tier: 3 }, BsrGI: { tier: 2 }, BssHII: { tier: 2, temp: 50 },
  BssSI: { tier: 3 }, BstAPI: { tier: 3 }, BstBI: { tier: 2, temp: 65 },
  BstEII: { tier: 2, temp: 60 }, BstNI: { tier: 3, temp: 60 }, BstXI: { tier: 2 },
  BstYI: { tier: 3, dam: "blocked" }, BstZ17I: { tier: 3 }, Bsu36I: { tier: 3 },
  BtgI: { tier: 3 }, ClaI: { tier: 1, dam: "blocked" }, DraI: { tier: 2 },
  DraIII: { tier: 3 }, DrdI: { tier: 3 }, EaeI: { tier: 3 }, EagI: { tier: 2 },
  EcoNI: { tier: 3 }, EcoO109I: { tier: 3 }, EcoRI: { tier: 1 }, EcoRV: { tier: 1 },
  EcoRII: { tier: 3, dcm: "blocked" }, FseI: { tier: 2 }, FspI: { tier: 3 },
  HaeII: { tier: 3 }, HincII: { tier: 2 }, HindIII: { tier: 1 }, HpaI: { tier: 2 },
  KasI: { tier: 3 }, KpnI: { tier: 1 }, MfeI: { tier: 2 }, MluI: { tier: 1, dam: "blocked" },
  MscI: { tier: 3 }, MslI: { tier: 3 }, NaeI: { tier: 3 }, NarI: { tier: 3 },
  NcoI: { tier: 1 }, NdeI: { tier: 1 }, NgoMIV: { tier: 3 }, NheI: { tier: 1 },
  NotI: { tier: 1 }, NruI: { tier: 2, dam: "blocked" }, NsiI: { tier: 2 },
  NspI: { tier: 3 }, PacI: { tier: 1 }, PaeR7I: { tier: 3 }, PciI: { tier: 2 },
  PflFI: { tier: 3 }, PflMI: { tier: 3 }, PluTI: { tier: 3 }, PmeI: { tier: 1 },
  PmlI: { tier: 3 }, PpuMI: { tier: 3 }, PshAI: { tier: 3 }, PsiI: { tier: 3 },
  PspOMI: { tier: 3 }, PspXI: { tier: 3 }, PstI: { tier: 1 }, PvuI: { tier: 2 },
  PvuII: { tier: 1 }, RsrII: { tier: 3 }, SacI: { tier: 1 }, SacII: { tier: 2 },
  SalI: { tier: 1 }, SbfI: { tier: 2 }, ScaI: { tier: 2 }, SexAI: { tier: 3 },
  SfcI: { tier: 3 }, SfiI: { tier: 2, temp: 50 }, SfoI: { tier: 3 },
  SgrAI: { tier: 3 }, SmaI: { tier: 1, temp: 25 }, SmlI: { tier: 3 },
  SnaBI: { tier: 3 }, SpeI: { tier: 1 }, SphI: { tier: 2 }, SrfI: { tier: 3 },
  SspI: { tier: 2 }, StuI: { tier: 2, dcm: "blocked" }, StyI: { tier: 3 },
  SwaI: { tier: 2, temp: 25 }, TspMI: { tier: 3 }, Tth111I: { tier: 3 },
  XbaI: { tier: 1, dam: "blocked" }, XcmI: { tier: 3 }, XhoI: { tier: 1 },
  XmaI: { tier: 2 }, XmnI: { tier: 3 }, ZraI: { tier: 3 },

  // ---- Frequent cutters (4–5 bp sites): RFLP, Hi-C, methylation work -------
  AluI: { tier: 2 }, BfaI: { tier: 3 }, BstUI: { tier: 3, temp: 60 },
  CviQI: { tier: 3 }, DpnI: { tier: 1, dam: "required" },
  DpnII: { tier: 2, dam: "blocked" }, FatI: { tier: 3 }, Fnu4HI: { tier: 3 },
  HaeIII: { tier: 2 }, HhaI: { tier: 3 }, HinP1I: { tier: 3 }, HinfI: { tier: 2 },
  HpaII: { tier: 2 }, Hpy188I: { tier: 3 }, HpyCH4III: { tier: 3 },
  HpyCH4IV: { tier: 3 }, HpyCH4V: { tier: 3 }, MboI: { tier: 1, dam: "blocked" },
  MluCI: { tier: 3 }, MseI: { tier: 2 }, MspI: { tier: 2 }, NlaIII: { tier: 3 },
  NlaIV: { tier: 3 }, RsaI: { tier: 2 }, Sau3AI: { tier: 1 }, Sau96I: { tier: 3 },
  ScrFI: { tier: 3, dcm: "blocked" }, TaqI: { tier: 2, temp: 65, dam: "blocked" },
  TfiI: { tier: 3, temp: 65 }, Tsp509I: { tier: 3, temp: 65 }, TseI: { tier: 3 },

  // ---- Type IIS: cut outside the site (Golden Gate / MoClo) ----------------
  AarI: { tier: 2 }, AlwI: { tier: 3, dam: "blocked" }, BbsI: { tier: 1 },
  BbvI: { tier: 3 }, BccI: { tier: 3 }, BceAI: { tier: 3 }, BciVI: { tier: 3 },
  BmrI: { tier: 3 }, BpmI: { tier: 3 }, BpuEI: { tier: 3 }, BsaI: { tier: 1 },
  BseRI: { tier: 3 }, BsgI: { tier: 3 }, BsmAI: { tier: 3 }, BsmBI: { tier: 1, temp: 55 },
  BsmFI: { tier: 3 }, BspCNI: { tier: 3 }, BspMI: { tier: 3 }, BsrDI: { tier: 3, temp: 65 },
  BsrI: { tier: 3, temp: 65 }, BtgZI: { tier: 2 }, BtsI: { tier: 3, temp: 55 },
  EarI: { tier: 2 }, EciI: { tier: 3 }, FauI: { tier: 3 }, FokI: { tier: 2 },
  HgaI: { tier: 3 }, HphI: { tier: 3, dam: "blocked" }, HpyAV: { tier: 3 },
  MlyI: { tier: 3 }, MmeI: { tier: 3 }, MnlI: { tier: 3 }, PleI: { tier: 3 },
  SapI: { tier: 1 }, SfaNI: { tier: 3 },

  // ---- Homing endonucleases: very rare sites, large-construct work ---------
  "I-SceI": { tier: 3 }, "I-CeuI": { tier: 3 }, "PI-SceI": { tier: 3 }, "PI-PspI": { tier: 3 },
};

// ---------------------------------------------------------------------------
// Parse REBASE bionet
// ---------------------------------------------------------------------------
const RC = { A: "T", T: "A", C: "G", G: "C", R: "Y", Y: "R", S: "S", W: "W",
             K: "M", M: "K", B: "V", V: "B", D: "H", H: "D", N: "N" };
const revcomp = (s) => s.split("").reverse().map((c) => RC[c] || c).join("");

// The REBASE source file is not redistributed with this repo; fetch on demand.
if (!fs.existsSync(SRC)) {
  console.log("fetching REBASE…");
  fs.mkdirSync("data-src", { recursive: true });
  const res = await fetch(SRC_URL);
  if (!res.ok) throw new Error(`REBASE fetch failed: ${res.status}`);
  fs.writeFileSync(SRC, await res.text());
}
const raw = fs.readFileSync(SRC, "utf8");

// Bairoch format: one record per enzyme, fields ID / ET / PT / RS / CR, ended by //
//   RS   GGTCTC, 7; GAGACC, -5;      site, cut offset (per strand)
//   CR   NSV.                        commercial sources
const entries = new Map();
let cur = null;
for (const line of raw.split("\n")) {
  const tag = line.slice(0, 2);
  const body = line.slice(5).trim();
  if (tag === "ID") cur = { name: body, prototype: body, rs: "", cr: "", type: "" };
  else if (!cur) continue;
  else if (tag === "ET") cur.type = body;
  else if (tag === "PT") cur.prototype = body || cur.name;
  else if (tag === "RS") cur.rs += body;
  else if (tag === "CR") cur.cr = body.replace(/\.$/, "");
  else if (line.startsWith("//")) { entries.set(cur.name, cur); cur = null; }
}

function parseEnzyme(name, entry) {
  // "GGTCTC, 7; GAGACC, -5;"  ->  site + both cut offsets in top-strand frame.
  const parts = entry.rs.split(";").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const parsed = parts.map((p) => {
    const m = p.match(/^([A-Z]+),\s*(-?\d+)$/);
    return m ? { seq: m[1], cut: parseInt(m[2], 10) } : null;
  });
  if (parsed.some((p) => !p)) return null;

  const site = parsed[0].seq;
  const cutTop = parsed[0].cut;
  // A second entry describes the complementary strand, whose offset runs the
  // other way; with only one entry the site is palindromic and cut symmetrically.
  const cutBottom = parsed.length > 1 ? site.length - parsed[1].cut : site.length - cutTop;
  if (!/^[ACGTRYSWKMBDHVN]+$/.test(site)) return null;
  return { site, cutTop, cutBottom };
}

// Build isoschizomer groups from REBASE's prototype field so we can offer
// alternative supplier names (BsmBI ⇄ Esp3I, BbsI ⇄ BpiI, …).
const byPrototype = new Map();
for (const [name, e] of entries) {
  if (!byPrototype.has(e.prototype)) byPrototype.set(e.prototype, []);
  byPrototype.get(e.prototype).push(name);
}

const WANTED_ALIASES = new Set(Object.keys(CATALOG));
const out = [];
const missing = [];

for (const [name, meta] of Object.entries(CATALOG)) {
  const entry = entries.get(name);
  if (!entry) { missing.push(name); continue; }
  const parsed = parseEnzyme(name, entry);
  if (!parsed) { missing.push(name + " (no cut site)"); continue; }

  // Aliases: other names sharing this prototype, excluding ones we already
  // ship under their own entry, capped to keep the payload small.
  const aliases = (byPrototype.get(entry.prototype) || [])
    .filter((n) => n !== name && !WANTED_ALIASES.has(n) && /^[A-Z]/.test(n))
    .slice(0, 4);

  const suppliers = [...(entry.cr || "")].map((c) => SUPPLIERS[c]).filter(Boolean);

  out.push({
    name,
    site: parsed.site,
    cutTop: parsed.cutTop,
    cutBottom: parsed.cutBottom,
    tier: meta.tier,
    ...(meta.temp ? { temp: meta.temp } : {}),
    ...(meta.dam ? { dam: meta.dam } : {}),
    ...(meta.dcm ? { dcm: meta.dcm } : {}),
    ...(meta.buffers ? { buffers: meta.buffers } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(suppliers.length ? { suppliers } : {}),
  });
}

out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

const header = `// GENERATED by scripts/build-enzymes.mjs — do not edit by hand.
//
// Recognition sites and cut coordinates from REBASE (http://rebase.neb.com),
// Copyright (c) Dr. Richard J. Roberts. Free for academic use.
// Source file: ${raw.split("\\n")[1]?.trim() || "REBASE bionet"}
//
// cutTop / cutBottom are offsets from the start of the recognition site on the
// top strand. For Type IIS enzymes they fall outside the site itself.
`;
fs.writeFileSync(OUT, header + "export const ENZYME_DATA = " + JSON.stringify(out, null, 1) + ";\n");

const iis = out.filter((e) => e.cutTop > e.site.length).length;
console.log(`wrote ${out.length} enzymes -> ${OUT}`);
console.log(`  Type IIS (cut outside site): ${iis}`);
console.log(`  tier 1 / 2 / 3: ${[1,2,3].map(t => out.filter(e => e.tier === t).length).join(" / ")}`);
console.log(`  with aliases: ${out.filter((e) => e.aliases).length}`);
if (missing.length) console.log(`  MISSING (${missing.length}): ${missing.join(", ")}`);
