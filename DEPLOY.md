# Deploying to fly.io

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
| `.dockerignore` | Keeps `node_modules`, `dist`, `.git`, `data-src` and `*.md` out of the build context |

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

**The bundle is one large chunk.** About 710 kB of JavaScript, 186 kB gzipped,
most of it the bundled enzyme table and sample sequences. It is served once per
cold visit and then cached for a year. Sequences too large to bundle are marked
lazy and fetched from NCBI by the browser, so their bandwidth is NCBI's rather
than this deployment's.

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

## Verified locally

The image was built and driven in a browser when this was written:

- `nginx -t` clean; `/healthz` 200; 404 for a missing asset
- CSP, `X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy`
  present on the shell, on a hashed asset and on a fallback path
- `Cache-Control: no-cache` on the shell, `immutable` on `/assets/*`
- gzip active (710 kB bundle → 228 kB on the wire)
- the app loaded and rendered with no CSP violations in the console
- `NC_005816` fetched from NCBI through the app under the production CSP —
  9,609 bp, 20 features, the correct pPCP1 record
- `api.anthropic.com` reachable through the policy: a deliberately invalid key
  returned HTTP 401 from the API rather than a blocked request
- a fetch to an unlisted host was refused, so the policy is enforced and not
  merely present

That is a record of one occasion, not a standing guarantee. To repeat it:

```bash
docker build -t virge:test . && docker run --rm -p 8099:80 virge:test
```
