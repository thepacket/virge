# Deploying to fly.io

Deployed at **[virge.fly.dev](https://virge.fly.dev)**.

VIRGE has no server component. The Docker image is a Vite build served by
nginx, so a deployment is static files behind Fly's TLS terminator — no
secrets, no environment variables, no volumes, no database.

That is not just a simplification, it is the security model. The assistant's
Anthropic API key is entered in the browser and kept in `localStorage`; it is
sent from the visitor's browser straight to `api.anthropic.com` and never
reaches this deployment. There is nowhere here to put a shared key, and no
shared key to drain.

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | Two stages: `node:22-alpine` runs `npm ci && npm run build`, `nginx:1.27-alpine` serves `dist/` |
| `nginx.conf` | Caching, gzip, single-page fallback, `/healthz` |
| `security-headers.conf` | CSP and the other response headers, included per-location |
| `fly.toml` | App name, region, machine size, health check |
| `.dockerignore` | Keeps `node_modules`, `dist`, `.git`, `data-src`, `docs/` and `*.md` out of the build context |

## First deploy

```bash
fly launch --no-deploy
```

Answer no when it offers to overwrite `fly.toml`. It will rename the app if
`virge` is taken, and it may change `primary_region` — the config here defaults
to `yyz` (Toronto).

Then:

```bash
fly deploy
```

Subsequent deploys are the same `fly deploy`. Nothing else needs configuring;
the app is reachable at `https://<app>.fly.dev`.

## What the configuration assumes

**The machine can sleep.** `auto_stop_machines = 'suspend'` with
`min_machines_running = 0` means an idle deployment costs nothing and the first
request after an idle period pays a wake-up of roughly a second. Set
`min_machines_running = 1` if that matters.

**256 MB, one shared CPU.** nginx serving static files needs a fraction of
this. The work VIRGE does — site searching, fragment assembly, canvas
rendering — happens in the visitor's browser, not here.

**The bundle is one large chunk.** About 1,019 kB of JavaScript — the enzyme
table, the bundled sample sequences, the Anthropic SDK, and marked + DOMPurify
+ KaTeX for rendering the assistant's replies. It is served once per cold visit
and then cached for a year. Sequences too large to bundle are marked lazy and
fetched from NCBI by the browser, so their bandwidth is NCBI's rather than this
deployment's.

**Fly's edge compresses, not nginx.** Measured against the live deployment:
1,019 kB uncompressed, 449 kB with gzip, **307 kB** with brotli/zstd. The edge
re-encodes, so the nginx `gzip on` directive is not what visitors get — it is
not redundant either, since it covers a direct hit on the container, which is
how the image is smoke tested. A `curl -I` shows no `content-encoding` at all,
because Fly does not compress a HEAD response: measure with a real GET.

## Caching

`/assets/*` is fingerprinted by Vite and served `immutable` for a year;
`index.html` is served `no-cache` so a deploy reaches clients that already have
the shell. Getting this backwards is the usual way a static deploy appears not
to have taken effect.

## Content Security Policy

`connect-src` allows exactly two hosts:

- `eutils.ncbi.nlm.nih.gov` — accession fetches and the lazily-loaded genomes
- `api.anthropic.com` — the assistant, and only once the visitor has entered
  their own key

Two hosts are deliberately absent:

- `rebase.neb.com` is **build-time only**. Enzyme data is fetched by
  `npm run build:enzymes` and committed as a generated module, so the browser
  never reaches REBASE. It appears in `src/` only as an attribution comment.
- `platform.claude.com` is a **link target** in the key-setup panel. A
  navigation is not a fetch, and widening `connect-src` for an href would be
  wrong.

`npm run build` runs `npm run check:csp` first, which scans `src/` and
`index.html` for hosts and fails the build on any that `connect-src` omits.
This exists because the failure mode is invisible while developing: the dev
server sets no CSP, so a new endpoint works locally and is silently refused in
production. `api.anthropic.com` is reached through the SDK rather than a URL
literal, so the script lists it explicitly — otherwise it would be reported as
allowed-but-unused.

`script-src` and `style-src` need no `'unsafe-inline'`: the Vite build emits an
external module and a linked stylesheet, and the app sets no style attributes.
Adding an inline handler or a `style="…"` attribute would break in production
and pass in dev — the same asymmetry, without a check to catch it.

**`style-src` is load-bearing for the assistant.** KaTeX's default HTML output
writes inline `style` attributes — four on `x^2` alone — which this policy
blocks. `src/markdown.js` therefore renders maths to MathML, which writes none
and needs no webfonts. Switching that `output` setting back would appear to work
in dev and render broken equations in production, and it would also drag ~1 MB
of KaTeX fonts into the bundle.

## Verified

Both against a local container and against the live deployment, when this was
written:

- `nginx -t` clean; `/healthz` 200; 404 for a missing asset
- CSP, `X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy`
  present on the shell, on a hashed asset and on a fallback path
- `Cache-Control: no-cache` on the shell, `immutable` on `/assets/*`
- compression active — 449 kB gzip, 307 kB brotli/zstd through Fly's edge
- the app loaded and rendered with no CSP violations in the console
- `NC_005816` fetched from NCBI through the app under the production CSP —
  9,609 bp, 20 features, the correct pPCP1 record
- `api.anthropic.com` reachable through the policy: a deliberately invalid key
  returned HTTP 401 from the API rather than a blocked request
- a fetch to an unlisted host was refused, so the policy is enforced and not
  merely present

On https://virge.fly.dev specifically: `force_https` redirects plain http with a
301, all four security headers survive Fly's proxy unchanged, the caching split
holds, and `NC_005816` again fetched and parsed correctly with a clean console.

That is a record of one occasion, not a standing guarantee. To repeat the local
half:

```bash
docker build -t virge:test . && docker run --rm -p 8099:80 virge:test
```
