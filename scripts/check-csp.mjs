/**
 * Fails the build when the source talks to a host the production CSP forbids.
 *
 * A blocked fetch is invisible while developing: the dev server sets no CSP, so
 * every request works locally and the same request is silently refused in
 * production. Testing cannot catch that asymmetry; only a check can.
 *
 * Two kinds of host are deliberately not in connect-src and must not be added
 * to it by this script's prompting — they are listed below instead.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Navigations, not fetches. Widening connect-src for an href would be wrong.
const LINK_ONLY = new Set([
  "https://platform.claude.com", // "Get a key" in the assistant's key setup
]);

// Build-time only: enzyme and sample data are fetched by scripts/build-*.mjs and
// committed as generated modules, so the browser never reaches these. They
// appear in src/ only as attribution comments.
const BUILD_TIME_ONLY = new Set([
  "https://rebase.neb.com",
  "http://rebase.neb.com",
]);

// Reached through a dependency rather than a URL literal, so scanning source
// will never find them. Listed so the "allowed but unused" warning stays honest.
const VIA_SDK = new Set([
  "https://api.anthropic.com", // @anthropic-ai/sdk's default baseURL
]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.js$/.test(entry)) out.push(path);
  }
  return out;
}

const hosts = new Set();
for (const file of [...sourceFiles("src"), "index.html"]) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/https?:\/\/[a-zA-Z0-9.-]+/g)) hosts.add(match[0]);
}

const conf = readFileSync("security-headers.conf", "utf8");
// The policy value first, then the directive inside it. Matching `connect-src`
// against the whole file would find the word in this file's own comments.
const policy = /Content-Security-Policy\s+"([^"]*)"/.exec(conf)?.[1];
if (!policy) {
  console.error("CSP: no Content-Security-Policy header found in security-headers.conf");
  process.exit(1);
}
const connectSrc = /(?:^|;)\s*connect-src([^;]*)/.exec(policy)?.[1] ?? "";
const allowed = new Set(connectSrc.match(/https:\/\/[a-zA-Z0-9.-]+/g) ?? []);
if (allowed.size === 0) {
  console.error("CSP: connect-src parsed as empty — the check would pass vacuously.");
  process.exit(1);
}

const exempt = (h) => LINK_ONLY.has(h) || BUILD_TIME_ONLY.has(h);
const missing = [...hosts].filter((h) => !exempt(h) && !allowed.has(h)).sort();
const unused = [...allowed].filter((h) => !hosts.has(h) && !VIA_SDK.has(h)).sort();

if (missing.length > 0) {
  console.error("CSP: the source fetches hosts that connect-src does not allow.");
  console.error("These will fail in production and work in dev:\n");
  for (const host of missing) console.error(`  ${host}`);
  console.error("\nAdd them to connect-src in security-headers.conf, or to");
  console.error("LINK_ONLY / BUILD_TIME_ONLY in scripts/check-csp.mjs if they are");
  console.error("navigations or build-time fetches rather than runtime ones.");
  process.exit(1);
}

if (unused.length > 0) {
  console.warn(`CSP: allowed but no longer used — ${unused.join(" ")}`);
}

const fetched = [...hosts].filter((h) => !exempt(h)).length + VIA_SDK.size;
console.log(`CSP: ${fetched} fetched hosts, all allowed.`);
