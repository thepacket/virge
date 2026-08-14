import { defineConfig } from "vite";
import { assistantProxy } from "./server/assistant-proxy.js";

// The assistant proxy is a dev-server middleware: it holds ANTHROPIC_API_KEY
// server-side so the key is never bundled into the client or committed. A
// static production build has no proxy, so the assistant reports itself
// unavailable there unless you host an equivalent endpoint.
export default defineConfig({
  plugins: [assistantProxy()],
});
