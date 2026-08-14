// Vite dev-server middleware that proxies the assistant's requests to the
// Claude API.
//
// Why a proxy at all: this repository is public and the app is static. An API
// key placed in client code would be committed and shipped to every visitor.
// Here the key is read from the server's environment, never leaves this
// process, and the browser talks only to its own origin.
//
// The browser owns the tool-use loop (tools operate the app, so they must run
// there); this endpoint is a single stateless turn. Model, system prompt and
// tool schemas live here rather than in the request body, so the endpoint
// can't be driven as an open relay for arbitrary prompts.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, TOOLS } from "./assistant-config.js";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 16000;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 4_000_000) reject(new Error("request body too large"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const send = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
};

/** Basic shape check — the client sends conversation turns and nothing else. */
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "messages must be a non-empty array";
  if (messages.length > 120) return "conversation too long";
  for (const m of messages) {
    if (m?.role !== "user" && m?.role !== "assistant") return "each message needs role user or assistant";
    if (typeof m.content !== "string" && !Array.isArray(m.content)) return "message content must be text or blocks";
  }
  return null;
}

export function assistantProxy() {
  return {
    name: "virge-assistant-proxy",
    configureServer(server) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const client = apiKey ? new Anthropic({ apiKey }) : null;
      if (!client) {
        server.config.logger.warn(
          "[assistant] ANTHROPIC_API_KEY is not set — the AI assistant will report itself unavailable."
        );
      }

      server.middlewares.use("/api/assistant", async (req, res) => {
        if (req.method === "GET") {
          return send(res, 200, { available: !!client, model: client ? MODEL : null });
        }
        if (req.method !== "POST") return send(res, 405, { error: "use POST" });
        if (!client) {
          return send(res, 503, {
            error: "The assistant needs an API key. Set ANTHROPIC_API_KEY in the environment " +
                   "and restart the dev server (see README).",
          });
        }

        let payload;
        try {
          payload = await readJson(req);
        } catch (err) {
          return send(res, 400, { error: `could not read request: ${err.message}` });
        }
        const invalid = validateMessages(payload.messages);
        if (invalid) return send(res, 400, { error: invalid });

        // Stable prefix (system + tools) is cached; the volatile app-state
        // snapshot rides in the caller's latest turn, after the breakpoint.
        const request = {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: TOOLS,
          output_config: { effort: "medium" },
          messages: payload.messages,
        };

        try {
          // Opus 5's safety classifiers can decline a request; a server-side
          // fallback re-runs it on Anthropic's recommended model rather than
          // surfacing the refusal. Beta, so fall back to a plain call if the
          // account can't use it.
          let message;
          try {
            message = await client.beta.messages.create({
              ...request,
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            });
          } catch (err) {
            const beta_unavailable = err?.status === 400 || err?.status === 404;
            if (!beta_unavailable) throw err;
            server.config.logger.warn(
              `[assistant] server-side fallbacks unavailable (${err.status}); continuing without them.`
            );
            message = await client.messages.create(request);
          }

          // Check stop_reason before trusting content: a refusal returns 200
          // with empty or partial content.
          if (message.stop_reason === "refusal") {
            return send(res, 200, {
              refusal: true,
              category: message.stop_details?.category ?? null,
              explanation: message.stop_details?.explanation ?? null,
            });
          }

          return send(res, 200, {
            id: message.id,
            model: message.model,
            stop_reason: message.stop_reason,
            content: message.content,
            usage: message.usage,
          });
        } catch (err) {
          // Typed SDK errors, most specific first.
          if (err instanceof Anthropic.AuthenticationError) {
            return send(res, 502, { error: "The API key was rejected. Check ANTHROPIC_API_KEY." });
          }
          if (err instanceof Anthropic.RateLimitError) {
            return send(res, 429, { error: "Rate limited by the API — wait a moment and retry." });
          }
          if (err instanceof Anthropic.APIConnectionError) {
            return send(res, 504, { error: "Could not reach the API. Check your connection." });
          }
          if (err instanceof Anthropic.APIError) {
            return send(res, 502, { error: `API error ${err.status}: ${err.message}` });
          }
          server.config.logger.error(`[assistant] ${err?.stack || err}`);
          return send(res, 500, { error: "Unexpected server error — see the dev-server log." });
        }
      });
    },
  };
}
