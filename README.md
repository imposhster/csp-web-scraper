# csp-web-scraper

Scrapes Microsoft Learn CSP documentation and mirrors the monthly Policy DDF zip. Publishes two artifacts to a stable GitHub release URL for downstream consumers (e.g. `cpt-csp-ui`).

> **Looking for developer handoff docs?** See [`docs/`](docs/README.md) — architecture, data sources, parsing rules, artifact schemas, CI pipeline, Java/Kotlin port guide, and design decisions.

## Artifacts

Every build produces two zips attached to the `latest` GitHub release:

### csp-docs.zip (~0.8 MB, 178 markdown files)

```
manifest.json
slugs.json
pages/
  accountmanagement-csp.md
  accountmanagement-ddf.md
  bitlocker-csp.md
  bitlocker-ddf-file.md
  policy-configuration-service-provider.md
  ...
```

Raw `?accept=text/markdown` responses from Microsoft Learn — YAML frontmatter intact, XML DDF blocks preserved inside fenced code blocks.

### policy-ddf.zip (~10 MB, ~250 XML files)

```
manifest.json
extracted/
  Policy_Admx_AboveLock.xml
  Policy_Admx_ActiveXControls.xml
  ...
```

Microsoft's monthly Policy DDF zip, extracted. The download URL is auto-discovered each build by parsing the scraped `configuration-service-provider-ddf` page — no manual URL updates when Microsoft rotates from `DDFv2Feb2026.zip` to `DDFv2Mar2026.zip`. The download + extract are skipped entirely if the discovered URL is unchanged since the prior run.

## Consumer URLs (stable)

```
https://github.com/imposhster/csp-web-scraper/releases/latest/download/csp-docs.zip
https://github.com/imposhster/csp-web-scraper/releases/latest/download/policy-ddf.zip
```

Public repo, no auth required. Each URL always points to the most recent successful build.

## Scope

Everything under `/windows/client-management/mdm/` on Microsoft Learn:

- Every `{name}-csp` and `{name}-ddf*` page (~147 of them).
- Top-level overview pages (CSP reference, DDF files, WMI Bridge provider, OMA DM protocol support, Declared Configuration, etc.).
- The Policy CSP overview page (`policy-configuration-service-provider`).
- **Excluded** from the markdown zip: all `policy-csp-*` area pages and the `policy-ddf-file` page — these are fully described by the Policy DDF XML and would bloat the markdown zip.

## Local run

```bash
npm install
npm run build
```

Pipeline:
1. `fetch:toc` — downloads `toc.json`, writes filtered slug list to `state/slugs.json`.
2. `fetch:pages` — concurrent markdown fetch with `If-Modified-Since`, writes `output/*.md` and `state/manifest.json`.
3. `fetch:policy-ddf` — parses the scraped DDF overview markdown for the current zip URL, short-circuits if unchanged since last run, else downloads + extracts to `state/policy-ddf/extracted/`.
4. `pack` — builds `dist/csp-docs.zip` and `dist/policy-ddf.zip`.

First full run ~20–30s. Re-runs finish in ~2s (all pages `304` + Policy DDF URL unchanged).

### Env var overrides

| Var | Default | Purpose |
|-----|---------|---------|
| `CSP_TOC_URL` | Microsoft Learn toc.json | Override TOC source |
| `CSP_MDM_BASE_URL` | Microsoft Learn mdm base | Override page base URL |
| `CSP_MAX_CONCURRENCY` | `8` | Parallel markdown fetches |
| `CSP_FORCE_REFRESH=1` | — | Ignore state, re-fetch every markdown page |
| `CSP_SKIP_FETCH=1` | — | Re-pack existing `output/` / `state/` without network calls |

## CI

`.github/workflows/build.yml` runs weekly (Mondays 06:00 UTC) and on manual dispatch. Each run:

1. Restores `state/` via `actions/cache`.
2. Pulls the prior `csp-docs.zip` and `policy-ddf.zip` from the `latest` release to warm `output/` and `state/policy-ddf/extracted/` (so `If-Modified-Since` and the Policy DDF URL short-circuit work on a fresh runner).
3. Runs `npm run build`.
4. Deletes and recreates the `latest` release with both zips attached.

## Integrating into cpt-csp

Two drop-ins in `examples/`:

### 1. `examples/fetch-csp-docs.mjs`

Downloads the markdown zip into `backend/data/csp-docs/`. Copy to `cpt-csp-ui/backend/scripts/fetch-csp-docs.mjs`.

### 2. `examples/fetch-policy-ddf.mjs`

Replaces `download-ddf.mjs` + `extract-ddf.mjs` in cpt-csp-ui. Downloads the Policy DDF zip into `backend/data/ddf/`, producing `backend/data/ddf/extracted/*.xml` and `backend/data/ddf/manifest.json` — the same layout the existing `build-catalog.mjs` already expects.

### cpt-csp-ui package.json diff

Replace the DDF lines with:

```json
{
  "scripts": {
    "fetch:csp-docs": "node scripts/fetch-csp-docs.mjs",
    "fetch:policy-ddf": "node scripts/fetch-policy-ddf.mjs",
    "build:catalog": "node scripts/build-catalog.mjs",
    "prepare:catalog": "npm run fetch:policy-ddf && npm run fetch:csp-docs && npm run build:catalog"
  }
}
```

Delete `scripts/download-ddf.mjs` and `scripts/extract-ddf.mjs`. Keep `unzipper` (already a dep).

### Optional env vars in cpt-csp

| Var | Purpose |
|-----|---------|
| `CSP_DOCS_URL` | Override csp-docs.zip source |
| `POLICY_DDF_URL` | Override policy-ddf.zip source |
| `CSP_DOCS_SKIP_DOWNLOAD=1` | Skip csp-docs download if manifest exists (CI caching) |
| `POLICY_DDF_SKIP_DOWNLOAD=1` | Skip policy-ddf download if manifest exists |

## Project layout

```
scripts/
  paths.mjs             # central URLs, paths, env vars
  http.mjs              # redirect-following GET with custom headers
  fetch-toc.mjs         # toc.json walk + Policy filter → state/slugs.json
  fetch-pages.mjs       # concurrent markdown fetch with If-Modified-Since
  fetch-policy-ddf.mjs  # auto-discover DDF zip URL, download + extract if changed
  pack.mjs              # zips output/ and state/policy-ddf/extracted/ → dist/
  build.mjs             # orchestrator
examples/
  fetch-csp-docs.mjs    # drop-in for cpt-csp-ui (markdown zip)
  fetch-policy-ddf.mjs  # drop-in for cpt-csp-ui (replaces download-ddf + extract-ddf)
output/                 # gitignored — raw markdown pages
state/                  # gitignored — slugs.json, manifest.json, policy-ddf/
dist/                   # gitignored — csp-docs.zip, policy-ddf.zip
```
