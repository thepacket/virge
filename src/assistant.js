// The AI assistant panel.
//
// The tool-use loop runs here rather than on the server, because the tools
// operate the live app: they read state, load DNA, and add lanes. The server
// endpoint (/api/assistant) is one stateless turn that holds the API key.
//
// Flow: send conversation -> get a message back -> if it contains tool_use
// blocks, run them locally and send the results as the next user turn ->
// repeat until the model stops calling tools.
import { SAMPLES, GROUPS } from "./data/samples.js";
import { ENZYMES, lookup, endType, siteWithCut, bufferWarning,
         overhangSignature, compatibleEnds } from "./enzymes.js";
import { digest } from "./digest.js";

const $ = (sel) => document.querySelector(sel);
const MAX_TOOL_ROUNDS = 8;

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
  el.textContent = text;
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

async function postTurn(messages) {
  const res = await fetch("/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
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

  bubble("user", text);
  history.push({
    role: "user",
    content: [{ type: "text", text: `${text}\n\n${stateSnapshot()}` }],
  });

  const thinking = toolNote("thinking…");
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const reply = await postTurn(history);

      if (reply.refusal) {
        thinking.remove();
        bubble("assistant", "I can't help with that request." +
          (reply.category ? ` (declined: ${reply.category})` : ""), "error");
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
    bubble("assistant", err.message, "error");
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
}

// ---------- wiring ----------
export async function initAssistant() {
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

  // Is a key configured? Report honestly rather than failing on first use.
  try {
    const res = await fetch("/api/assistant");
    const info = await res.json();
    if (!info.available) {
      setInputEnabled(false);
      $("#chat-status").textContent =
        "Set ANTHROPIC_API_KEY and restart the dev server to enable the assistant.";
      $("#chat-status").hidden = false;
      return;
    }
    $("#chat-status").hidden = true;
  } catch {
    setInputEnabled(false);
    $("#chat-status").textContent = "Assistant endpoint unreachable — is the dev server running?";
    $("#chat-status").hidden = false;
  }
}
