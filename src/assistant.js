// The AI assistant panel.
//
// The user supplies their own API key through the UI; it is kept in this
// browser (localStorage) and sent only to api.anthropic.com. There is no
// server component, so the assistant works in a static build as well as in dev.
//
// Calling the API from a browser needs `dangerouslyAllowBrowser` — the SDK
// then sends the `anthropic-dangerous-direct-browser-access` header the API
// requires. The name is a real warning, not a formality: a key held in a page
// is readable by anything else running in that page, so the UI says so and
// offers a one-click Forget.
//
// The tool-use loop runs here because the tools operate the live app: they read
// state, load DNA, and add lanes. Flow: send conversation -> get a message ->
// if it contains tool_use blocks, run them and send the results back as one
// user turn -> repeat until the model stops calling tools.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, TOOLS } from "./assistant-config.js";
import { SAMPLES, GROUPS } from "./data/samples.js";
import { ENZYMES, lookup, endType, siteWithCut, bufferWarning,
         overhangSignature, compatibleEnds } from "./enzymes.js";
import { digest } from "./digest.js";
import { renderMarkdown } from "./markdown.js";

const $ = (sel) => document.querySelector(sel);
const MAX_TOOL_ROUNDS = 8;
const MAX_TOKENS = 16000;
const KEY_STORAGE = "virge-anthropic-key";
const MODEL_STORAGE = "virge-anthropic-model";

// The visitor pays for their own calls, so the choice is theirs to make rather
// than ours to make for them. Ordered most to least capable; `effort: "medium"`
// below is valid on all three (only `max` would fail on Haiku).
const MODELS = [
  { id: "claude-opus-5", label: "Opus 5",
    note: "most capable — best at multi-step setup and awkward digests" },
  { id: "claude-sonnet-5", label: "Sonnet 5",
    note: "balanced — a good default for questions about the loaded DNA" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5",
    note: "fastest and cheapest — fine for lookups, weaker at planning" },
];
const DEFAULT_MODEL = MODELS[0].id;

function readModel() {
  let saved = null;
  try { saved = localStorage.getItem(MODEL_STORAGE); } catch { /* private mode */ }
  // A stored id that is no longer offered would otherwise 404 on every turn.
  return MODELS.some((m) => m.id === saved) ? saved : DEFAULT_MODEL;
}

let model = DEFAULT_MODEL;
const modelLabel = (id) => MODELS.find((m) => m.id === id)?.label ?? id;

// Injected by main.js so the assistant can drive the app without importing
// its internals (which would be circular).
let app = null;
export function registerAssistantApp(api) { app = api; }

// ---------- tool implementations ----------
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const TOOL_IMPLS = {
  get_app_state() {
    const s = app.getState();
    return {
      dna: { name: s.dnaName, length: s.seq.length, topology: s.circular ? "circular" : "linear",
             features: s.features.length, annotated: s.features.length > 0 },
      methylation: s.methylation,
      gel: { agarose_percent: s.gelPct, ladder: s.ladderKey,
             exposure: `${s.exposure.toFixed(2)}x`, contrast_gamma: s.contrast },
      lanes: app.laneSummaries(),
    };
  },

  list_dna_samples({ group } = {}) {
    const entries = Object.entries(SAMPLES)
      .filter(([, s]) => !group || s.group.toLowerCase() === group.toLowerCase())
      .map(([key, s]) => ({ key, name: s.name, group: s.group, length: s.length,
                            topology: s.topology, on_demand: !!s.lazy,
                            features: s.features?.length ?? null }));
    return { groups: GROUPS, count: entries.length, samples: entries };
  },

  async load_dna({ key }) {
    if (!SAMPLES[key]) {
      return { error: `No sample '${key}'. Call list_dna_samples for valid keys.` };
    }
    await app.loadSample(key);
    const s = app.getState();
    return { loaded: s.dnaName, length: s.seq.length,
             topology: s.circular ? "circular" : "linear", features: s.features.length };
  },

  search_enzymes({ query = "", cuts = "any", type_iis_only = false, limit = 25 } = {}) {
    const q = query.trim().toLowerCase();
    const cap = clamp(Number(limit) || 25, 1, 60);
    const out = [];
    let matched = 0;
    for (const e of ENZYMES) {
      if (q && ![e.name, ...(e.aliases || [])].join(" ").toLowerCase().includes(q)) continue;
      if (type_iis_only && !e.typeIIS) continue;
      const n = app.cutCount(e);
      if (cuts === "zero" && n !== 0) continue;
      if (cuts === "one" && n !== 1) continue;
      if (cuts === "some" && n === 0) continue;
      matched++;
      if (out.length < cap) {
        out.push({ name: e.name, site: siteWithCut(e), cuts_loaded_dna: n, ends: endType(e),
                   temp_c: e.temp, type_iis: e.typeIIS,
                   aliases: e.aliases?.slice(0, 3) ?? [] });
      }
    }
    return { total_matches: matched, showing: out.length, enzymes: out,
             note: matched > out.length ? "Narrow the query or raise limit to see the rest." : undefined };
  },

  preview_digest({ enzymes }) {
    const resolved = [];
    const unknown = [];
    for (const name of enzymes || []) {
      const e = lookup(name);
      e ? resolved.push(e) : unknown.push(name);
    }
    if (unknown.length) {
      return { error: `Unknown enzyme(s): ${unknown.join(", ")}. Use search_enzymes to find the exact name.` };
    }
    if (!resolved.length) return { error: "Pass at least one enzyme." };
    return app.previewDigest(resolved);
  },

  add_lane({ enzymes }) {
    const check = TOOL_IMPLS.preview_digest({ enzymes });
    if (check.error) return check;
    app.addLane(enzymes);
    return { added: enzymes.join(" + "), ...check, lane_count: app.laneSummaries().length };
  },

  clear_lanes() {
    app.clearLanes();
    return { cleared: true, lane_count: 0 };
  },

  set_gel(opts = {}) {
    const applied = app.setGel(opts);
    return { applied, state: TOOL_IMPLS.get_app_state().gel };
  },

  compatible_ends({ enzyme }) {
    const e = lookup(enzyme);
    if (!e) return { error: `Unknown enzyme '${enzyme}'. Use search_enzymes to find the exact name.` };
    const sig = overhangSignature(e);
    return {
      enzyme: e.name,
      site: siteWithCut(e),
      end: sig.kind === "variable"
        ? "variable — set by flanking sequence (Type IIS, programmable)"
        : sig.kind === "blunt" ? "blunt" : `${sig.kind} ${sig.seq}`,
      ligates_with: compatibleEnds(e),
    };
  },
};

async function runTool(name, input) {
  const impl = TOOL_IMPLS[name];
  if (!impl) return { error: `No such tool: ${name}` };
  try {
    return await impl(input || {});
  } catch (err) {
    return { error: `${name} failed: ${err.message}` };
  }
}

// ---------- transcript ----------
const history = [];   // API-shaped conversation
let busy = false;

function bubble(role, text, cls = "") {
  const el = document.createElement("div");
  el.className = `chat-msg ${role}${cls ? " " + cls : ""}`;
  // Only the model's own replies are rendered as markdown. The user's turn is
  // echoed as plain text: there is nothing to gain from formatting your own
  // input, and it keeps one more string out of the HTML path.
  if (role === "assistant" && !cls) el.innerHTML = renderMarkdown(text);
  else el.textContent = text;
  $("#chat-log").appendChild(el);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  return el;
}

function toolNote(label) {
  const el = document.createElement("div");
  el.className = "chat-tool";
  el.textContent = label;
  $("#chat-log").appendChild(el);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  return el;
}

const TOOL_LABEL = {
  get_app_state: "reading the current setup",
  list_dna_samples: "listing DNA samples",
  load_dna: "loading DNA",
  search_enzymes: "searching enzymes",
  preview_digest: "checking a digest",
  add_lane: "adding a lane",
  clear_lanes: "clearing lanes",
  set_gel: "adjusting the gel",
  compatible_ends: "checking sticky ends",
};

// ---------- key handling (browser-local) ----------
let client = null;

const readKey = () => {
  try { return localStorage.getItem(KEY_STORAGE) || ""; } catch { return ""; }
};

function makeClient(key) {
  // dangerouslyAllowBrowser is required for browser use and makes the SDK send
  // the anthropic-dangerous-direct-browser-access header the API expects.
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
}

function setKey(key) {
  try { localStorage.setItem(KEY_STORAGE, key); } catch { /* private mode */ }
  client = makeClient(key);
  renderKeyState();
}

/** Drop the conversation the model sees, and the transcript showing it.
 *  Keeps the opening greeting and the suggestion chips. */
function clearConversation() {
  history.length = 0;
  $("#chat-log")
    .querySelectorAll(".chat-msg:not(:first-child), .chat-tool")
    .forEach((n) => n.remove());
  // The count described a request that is no longer part of any conversation,
  // and a stale number under the box is the bug this project just spent a
  // commit fixing for the import status.
  lastUsage = null;
  turnUsage = null;
  renderUsage();
  updateClearState();
}

function forgetKey() {
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
  client = null;
  clearConversation();
  renderKeyState();
}

/** Nothing to clear until there is a conversation, and never mid-turn. */
function updateClearState() {
  $("#chat-clear").disabled = busy || history.length === 0;
}

/** Show only enough of the key to recognise it — never the whole value. */
const maskKey = (k) => (k.length > 8 ? `…${k.slice(-4)}` : "…");

function renderKeyState() {
  const key = readKey();
  const hasKey = !!key;
  $("#chat-key-setup").hidden = hasKey;
  $("#chat-key-saved").hidden = !hasKey;
  $("#chat-form").hidden = !hasKey;
  if (hasKey) $("#chat-key-mask").textContent = maskKey(key);
  setInputEnabled(hasKey);
}

// ---------- token usage ----------
// A "turn" is not one request: the tool loop can issue up to MAX_TOOL_ROUNDS of
// them, each resending the whole conversation. Showing only the last request
// would understate a turn that took five, so the last request is what the line
// reports and the turn total rides in the tooltip.
let lastUsage = null;
let turnUsage = null;

function startTurnUsage() {
  turnUsage = { input: 0, output: 0, cached: 0, requests: 0 };
}

function recordUsage(usage) {
  if (!usage) return;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  // Cache reads are billed at a fraction of the input rate and are not included
  // in input_tokens, so leaving them out would misreport the cost of a long
  // conversation — the cached system prompt and tool schemas are most of it.
  const cached = usage.cache_read_input_tokens ?? 0;
  const created = usage.cache_creation_input_tokens ?? 0;
  lastUsage = { input, output, cached, created };
  if (turnUsage) {
    turnUsage.input += input + created;
    turnUsage.output += output;
    turnUsage.cached += cached;
    turnUsage.requests += 1;
  }
  renderUsage();
}

function renderUsage() {
  const el = $("#chat-usage");
  if (!lastUsage) { el.hidden = true; el.textContent = ""; el.removeAttribute("title"); return; }
  const n = (v) => v.toLocaleString();
  el.textContent = `${n(lastUsage.input)} in · ${n(lastUsage.output)} out` +
    (lastUsage.cached ? ` · ${n(lastUsage.cached)} cached` : "");
  el.title = turnUsage && turnUsage.requests > 1
    ? `Last request. This turn: ${n(turnUsage.input)} in, ${n(turnUsage.output)} out, ` +
      `${n(turnUsage.cached)} cached over ${turnUsage.requests} requests.`
    : "Tokens billed for the last request. Cached input bills at a fraction of the input rate.";
  el.hidden = false;
}

async function postTurn(messages) {
  if (!client) throw new Error("No API key set.");

  const request = {
    model,
    max_tokens: MAX_TOKENS,
    // Stable prefix (system + tools) is cached; the volatile state snapshot
    // rides in the user turn, after this breakpoint.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: TOOLS,
    output_config: { effort: "medium" },
    messages,
  };

  let message;
  try {
    // Safety classifiers can decline a request; a server-side fallback re-runs
    // it on Anthropic's recommended model instead of surfacing the refusal.
    // Beta — fall back to a plain call if the account or model can't use it.
    message = await client.beta.messages.create({
      ...request,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (err) {
    if (err?.status !== 400 && err?.status !== 404) throw err;
    message = await client.messages.create(request);
  }
  recordUsage(message?.usage);
  return message;
}

/** Turn an SDK error into something worth showing a user. */
function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return "That API key was rejected. Check it, or paste a different one.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return `This key doesn't have access to ${modelLabel(model)} (${model}). Try another model.`;
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Rate limited by the API — wait a moment and retry.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Couldn't reach the API. Check your connection.";
  }
  if (err instanceof Anthropic.APIError) {
    return `API error ${err.status}: ${err.message}`;
  }
  return err?.message || "Unexpected error.";
}

/** A compact state snapshot, appended to the user's turn so the model always
 *  knows what is loaded without spending a tool call. Placed after the cached
 *  prefix, so it never invalidates the cache. */
function stateSnapshot() {
  const s = app.getState();
  const lanes = app.laneSummaries();
  return `[current setup] DNA: ${s.dnaName}, ${s.seq.length.toLocaleString()} bp, ` +
    `${s.circular ? "circular" : "linear"}` +
    `${s.features.length ? `, ${s.features.length} features` : ", no annotations"}. ` +
    `Methylation: ${s.methylation}. Gel: ${s.gelPct}% agarose, ${s.ladderKey} ladder. ` +
    (lanes.length
      ? `Lanes: ${lanes.map((l) => `${l.enzymes} (${l.fragment_count} frags)`).join("; ")}.`
      : "No digest lanes yet.");
}

async function sendMessage(text) {
  if (busy) return;
  busy = true;
  setInputEnabled(false);
  startTurnUsage();

  bubble("user", text);
  history.push({
    role: "user",
    content: [{ type: "text", text: `${text}\n\n${stateSnapshot()}` }],
  });

  const thinking = toolNote("thinking…");
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const reply = await postTurn(history);

      // Check stop_reason before trusting content: a refusal comes back as a
      // successful response with empty or partial content.
      if (reply.stop_reason === "refusal") {
        thinking.remove();
        const category = reply.stop_details?.category;
        bubble("assistant", "I can't help with that request." +
          (category ? ` (declined: ${category})` : ""), "error");
        history.pop();
        return;
      }

      history.push({ role: "assistant", content: reply.content });

      for (const block of reply.content) {
        if (block.type === "text" && block.text.trim()) {
          thinking.remove();
          bubble("assistant", block.text.trim());
        }
      }

      const calls = reply.content.filter((b) => b.type === "tool_use");
      if (calls.length === 0) { thinking.remove(); return; }

      // Run every requested tool, then return all results in ONE user turn —
      // splitting them across turns teaches the model to stop parallelising.
      const results = [];
      for (const call of calls) {
        const note = toolNote(`${TOOL_LABEL[call.name] || call.name}…`);
        const result = await runTool(call.name, call.input);
        note.remove();
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: [{ type: "text", text: JSON.stringify(result) }],
          ...(result?.error ? { is_error: true } : {}),
        });
      }
      history.push({ role: "user", content: results });
    }
    thinking.remove();
    bubble("assistant", "I stopped after several tool steps without finishing — ask me to continue.", "error");
  } catch (err) {
    thinking.remove();
    bubble("assistant", describeError(err), "error");
    // Drop the turn that failed so the conversation stays valid for a retry.
    if (history.at(-1)?.role === "user") history.pop();
  } finally {
    busy = false;
    setInputEnabled(true);
    $("#chat-input").focus();
  }
}

function setInputEnabled(on) {
  $("#chat-input").disabled = !on;
  $("#chat-send").disabled = !on;
  // Locked mid-turn: postTurn reads the model per request, so switching between
  // tool rounds would finish someone else's reasoning on a different model.
  $("#chat-model").disabled = busy;
  updateClearState();
}

/** Fill the model picker and keep `model` in step with it. Switching mid-thread
 *  is allowed: the conversation is plain messages and tool results, which any
 *  of these models can pick up. It does void the prompt cache on the next turn,
 *  which costs a little but nothing correctness-wise. */
function initModelPicker() {
  const select = $("#chat-model");
  for (const m of MODELS) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    opt.title = m.note;
    select.append(opt);
  }

  model = readModel();
  select.value = model;

  select.addEventListener("change", () => {
    model = select.value;
    try { localStorage.setItem(MODEL_STORAGE, model); } catch { /* private mode */ }
    // Only worth saying inside a live conversation — on an empty log it would
    // be noise about a setting the user just watched themselves change.
    if (history.length > 0) toolNote(`switched to ${modelLabel(model)}`);
  });
}

// ---------- wiring ----------
export function initAssistant() {
  initModelPicker();

  // Key entry. The value is the user's own credential: it goes to
  // localStorage and to api.anthropic.com, nowhere else.
  $("#chat-key-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-key-input");
    const key = input.value.trim();
    if (!key) return;
    if (!/^sk-ant-/.test(key)) {
      $("#chat-key-error").textContent =
        "Anthropic keys start with “sk-ant-”. Paste the whole key.";
      $("#chat-key-error").hidden = false;
      return;
    }
    $("#chat-key-error").hidden = true;
    input.value = "";
    setKey(key);
    bubble("assistant", "Key saved in this browser. What would you like to look at?");
    $("#chat-input").focus();
  });

  $("#chat-key-forget").addEventListener("click", () => {
    forgetKey();
    bubble("assistant", "Key forgotten and this conversation cleared.");
  });

  $("#chat-clear").addEventListener("click", () => {
    if (busy) return;
    clearConversation();
    bubble("assistant", "Context cleared — I've forgotten this conversation. The gel and its lanes are untouched.");
    $("#chat-input").focus();
  });

  const form = $("#chat-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#chat-input").value.trim();
    if (!text) return;
    $("#chat-input").value = "";
    sendMessage(text);
  });

  // Enter sends, Shift+Enter makes a newline.
  $("#chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  $("#chat-log").addEventListener("click", (e) => {
    const chip = e.target.closest(".chat-suggestion");
    if (!chip || busy) return;
    sendMessage(chip.textContent);
  });

  // Restore a key saved in a previous session, if there is one.
  const saved = readKey();
  if (saved) client = makeClient(saved);
  renderKeyState();
}
