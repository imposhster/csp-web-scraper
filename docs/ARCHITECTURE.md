# Architecture

## Purpose

`csp-web-scraper` is a scheduled job that mirrors **all of Microsoft's public Configuration Service Provider (CSP) documentation** into two deterministic, versionless-but-always-latest zip artifacts published on GitHub Releases:

| Artifact | Contents | Size (today) |
|----------|----------|--------------|
| `csp-docs.zip` | Every markdown page under `/windows/client-management/mdm/` on Microsoft Learn, except the ~200 per-area Policy pages that are already described by XML | ~0.8 MB, 178 files |
| `policy-ddf.zip` | Microsoft's current monthly Policy DDF zip, extracted flat | ~0.7 MB, 313 XML files |

Downstream consumers (currently `cpt-csp-ui`) pull one or both zips from a stable URL at build time instead of scraping Microsoft themselves or hand-updating monthly URLs.

## System shape

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │                      Microsoft Learn                         │
                    │                                                              │
                    │  toc.json           {slug}?accept=text/markdown              │
                    │       │                       │                              │
                    └───────┼───────────────────────┼──────────────────────────────┘
                            │                       │
                            ▼                       ▼
         ┌────────────┐  ┌──────────────┐  ┌────────────────────────┐
         │ fetch-toc  │─▶│ fetch-pages  │─▶│ fetch-policy-ddf       │
         │  .mjs      │  │   .mjs       │  │   .mjs                 │
         └────────────┘  └──────────────┘  └────────────┬───────────┘
               │                │                        │
               ▼                ▼                        ▼          ┌──────────────────────┐
         state/slugs      output/*.md +            state/policy-    │  download.microsoft  │
         .json            state/manifest.json      ddf/extracted/   │  .com (DDF zip)      │
                                                   + state.json     └──────────┬───────────┘
               │                │                        │                     │
               └────────┬───────┴────────────┬──────────┘      (URL discovered │
                        ▼                    ▼                  by parsing the │
                   ┌──────────────────────────────┐             scraped DDF    │
                   │            pack.mjs          │             overview page) │
                   └────────────┬─────────────────┘ ◀───────────────────────────
                                ▼
                      dist/csp-docs.zip
                      dist/policy-ddf.zip
                                │
                                ▼
                   ┌──────────────────────────────┐
                   │  GitHub Actions release step │
                   │  (delete + recreate "latest")│
                   └────────────┬─────────────────┘
                                ▼
                   releases/latest/download/*.zip
                   (consumed by cpt-csp-ui)
```

## Components (per script)

Each script is a standalone ESM entrypoint in `scripts/`. They communicate only via files under `state/` and `output/`. There is no in-memory orchestrator state.

| Script | Input | Output | Responsibility |
|--------|-------|--------|----------------|
| `paths.mjs` | Env vars | Exported constants | Single source of truth for URLs and file paths; every other script reads paths from here. |
| `http.mjs` | URL + headers | `{status, headers, body}` | Redirect-following `https.get` wrapper; sets `User-Agent` and `Accept-Encoding: identity`. |
| `fetch-toc.mjs` | `toc.json` HTTP | `state/slugs.json` | Recursively walks the TOC JSON tree, normalizes hrefs, applies the Policy filter, writes a sorted slug list. |
| `fetch-pages.mjs` | `state/slugs.json`, prior `state/manifest.json` | `output/{slug}.md`, `state/manifest.json` | Concurrent fetch (8-wide pool) with `If-Modified-Since`/`If-None-Match` conditional headers and retry on 429/5xx. |
| `fetch-policy-ddf.mjs` | `output/configuration-service-provider-ddf.md`, prior `state/policy-ddf/state.json` | `state/policy-ddf/extracted/*.xml`, `state/policy-ddf/state.json` | Auto-discovers the current DDF zip URL via regex, short-circuits if unchanged, else downloads + flattens XMLs. |
| `pack.mjs` | `output/`, `state/policy-ddf/extracted/`, both manifests | `dist/csp-docs.zip`, `dist/policy-ddf.zip` | Builds both zip artifacts with their own root `manifest.json`. |
| `build.mjs` | — | — | Orchestrator: runs `fetch-toc → fetch-pages → fetch-policy-ddf → pack` sequentially, propagates non-zero exit codes. |

## Directory layout

```
csp-web-scraper/
├── scripts/                        # all logic; see table above
├── examples/                       # drop-in scripts for consumer projects
│   ├── fetch-csp-docs.mjs
│   └── fetch-policy-ddf.mjs
├── output/                         # gitignored — markdown for csp-docs.zip
├── state/                          # gitignored — persisted between runs
│   ├── slugs.json
│   ├── manifest.json               # per-page Last-Modified / ETag / bytes
│   └── policy-ddf/
│       ├── state.json              # discovered URL + upstream metadata
│       └── extracted/*.xml
├── dist/                           # gitignored — zip artifacts
│   ├── csp-docs.zip
│   └── policy-ddf.zip
├── docs/                           # this folder
├── .github/workflows/build.yml     # scheduled CI
└── package.json                    # ESM, Node 20+, only adm-zip dev dep
```

## State model

The pipeline is **restartable and idempotent** because all inter-stage communication lives in files, not memory:

| Location | Kept in | Purpose |
|----------|---------|---------|
| `state/slugs.json` | `actions/cache` + prior zip | Diff-able between runs to surface added/removed CSPs. |
| `state/manifest.json` | `actions/cache` | Per-page `Last-Modified`/`ETag` for conditional fetch. Lost state just means a one-time full re-pull; no data corruption. |
| `state/policy-ddf/state.json` | `actions/cache` | Remembers the last discovered DDF zip URL. URL equality is the primary change-detection signal. |
| `state/policy-ddf/extracted/*.xml` | `actions/cache` + prior zip | Working copy of extracted XML; also the source for `policy-ddf.zip`. |
| `output/*.md` | Prior zip restore | Working copy of markdown; consumed by `pack.mjs`. Ship of Theseus problem: the presence of the file plus the `manifest.json` entry is what counts. |

Because the working directories are restored from the prior release at the start of each CI run, **the `latest` release is itself part of the state**. If the release is deleted manually, the next run does a cold full fetch.

## Change detection (per pipeline stage)

| Stage | Detection mechanism | When it re-works |
|-------|---------------------|------------------|
| TOC | Always re-fetched (small file, gives us the authoritative source list) | Every run |
| Markdown pages | `If-Modified-Since: <last saved Last-Modified>` per slug; fallback `If-None-Match: <etag>` | Only when Microsoft edits a page |
| Policy DDF | URL string equality against prior `discoveredUrl`; bypasses even the HTTP request when the URL hasn't rotated | Only when Microsoft publishes a new monthly zip |
| Pack | Always runs — it's cheap and ensures zip invariants on every release | Every run |

Bypass knobs:
- `CSP_FORCE_REFRESH=1` — ignore all state, re-fetch every markdown page and the DDF zip.
- `CSP_SKIP_FETCH=1` — re-pack existing `output/` + `state/` without any network calls; useful for testing `pack.mjs`.

## CI runtime vs. local runtime

Local and CI run the **same scripts**; CI just adds state restoration and release publishing around them:

1. Local: `npm install && npm run build` → `dist/*.zip`
2. CI adds before the build:
   - `actions/cache@v4` restore of `state/`
   - Download-and-extract both prior zips into `output/` and `state/policy-ddf/extracted/` (warms the cache when `actions/cache` has no hit)
3. CI adds after the build:
   - Delete the `latest` release and re-create it with both zips attached.

## Failure modes

| Failure | Handling | Blast radius |
|---------|----------|--------------|
| TOC 5xx | Retry via normal HTTP (none today — TOC has no retry loop). Non-zero exit kills CI. | Whole run fails, no release publish. |
| Single page 404 | Logged, added to `manifest.missing[]`, stale file removed from `output/`, pipeline continues | Page simply drops from the next zip. |
| Single page 429/5xx | Exponential backoff, 3 retries per page | Delays that page; full pipeline delay bounded by ~30s. |
| Page errors after retries | Recorded in `manifest.errors[]`, **`fetch-pages.mjs` exits 2** (which blocks the release step). | Run fails loudly rather than shipping a degraded zip. |
| DDF URL regex miss (page format changed) | Throws with a clear message; non-zero exit | Run fails, previous `latest` release stays untouched. |
| DDF zip has 0 XML files | Throws | Run fails, previous release stays. |
| Release delete race (two workflows concurrent) | `concurrency: build-csp-docs` in workflow serializes runs | Concurrency primitive guarantees at most one in-flight job. |

## Invariants

These are the guarantees downstream consumers rely on. Do not break them without coordinating with `cpt-csp-ui`:

1. **URLs are stable** — `releases/latest/download/csp-docs.zip` and `releases/latest/download/policy-ddf.zip` always resolve to the newest successful build.
2. **Each zip has a root `manifest.json`** — consumers read it first to decide whether to re-ingest.
3. **Zip layouts are deterministic** — `csp-docs.zip` has `pages/`, `policy-ddf.zip` has `extracted/`. No subdirectory reshuffling.
4. **Output is UTF-8** — markdown, XML, and JSON inside the zips are always UTF-8, no BOM, LF or CRLF line endings preserved from source.
5. **Policy CSP overview is in csp-docs.zip** — `pages/policy-configuration-service-provider.md` is always present. The ~200 `policy-csp-*` area pages are always absent.

See `ARTIFACT-SCHEMAS.md` for the precise shape of each manifest.
