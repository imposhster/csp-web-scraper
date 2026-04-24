# CI Pipeline

Walkthrough of `.github/workflows/build.yml`. The workflow's job is to run the same pipeline that works locally, plus two things local doesn't need: **restoring state from the prior release** so change-detection works on fresh runners, and **replacing the `latest` release** so consumer URLs resolve to the new zips.

## Triggers

```yaml
on:
  schedule:
    - cron: '0 6 * * 1'    # Mondays 06:00 UTC
  workflow_dispatch:        # manual runs from the Actions UI
```

Weekly cadence balances freshness (Microsoft updates pages frequently but not by the hour) against compute cost. `workflow_dispatch` is the "push a button to ship" escape hatch.

## Concurrency

```yaml
concurrency:
  group: build-csp-docs
  cancel-in-progress: false
```

At most one build runs at a time. Cancelling in-progress runs was rejected because a half-finished release-replace would leave no `latest` release, breaking consumers until the next run.

## Permissions

```yaml
permissions:
  contents: write
```

Needed for `gh release delete` and `gh release create` against this repo. No other permissions are granted.

## Steps

### 1. Checkout + Node 20

Standard. `actions/setup-node@v4` caches `~/.npm` keyed by `package-lock.json` — irrelevant here because the project has one dev dependency, but it's free.

### 2. Restore `state/` via `actions/cache`

```yaml
- uses: actions/cache@v4
  with:
    path: state
    key: csp-scraper-state-v1
```

A single fixed key. Saves and restores `state/` unconditionally. First run has a miss; every subsequent run is a hit. If the cache is ever invalidated (GitHub's 10 GB per-repo limit, 7-day inactivity eviction, etc.), the next run does a full cold fetch — correct but slower.

Bump the key suffix (`-v2`) if the state format is ever changed incompatibly.

### 3. Restore `output/` and `extracted/` from the prior release

The `actions/cache` above handles `state/`, but not `output/`. Markdown files are the bulk of the data, and the zip from the prior release is the authoritative copy. We pull it and unzip to warm the working directories:

```bash
mkdir -p output state/policy-ddf/extracted
if gh release download latest --pattern csp-docs.zip ... ; then
  unzip /tmp/csp-docs.zip -d /tmp/prior-csp
  cp /tmp/prior-csp/pages/*.md output/
fi
if gh release download latest --pattern policy-ddf.zip ... ; then
  unzip /tmp/policy-ddf.zip -d /tmp/prior-ddf
  cp /tmp/prior-ddf/extracted/*.xml state/policy-ddf/extracted/
fi
```

If either download fails (e.g. first ever run — no `latest` release yet), we log and proceed cold.

**Why two sources of state?** `actions/cache` is fast but occasionally evicted. The prior release zip is slow (small download) but permanent. Having both means we effectively cache twice.

### 4. `npm ci` + `npm run build`

Install and run the full pipeline. Output lands in `dist/`.

### 5. Summarize

A small inline Node script reads both manifests and produces a release-notes line:

```
Built 2026-04-24. csp-docs: 178 pages (0 updated, 178 unchanged, 0 missing, 0 errors). policy-ddf: 313 XML files (source DDFv2Feb2026.zip, 0.69 MB).
```

Written to `$GITHUB_OUTPUT` as `notes=...` and consumed by the next step.

### 6. Replace the `latest` release

```bash
gh release delete latest --cleanup-tag --yes 2>/dev/null || true
ASSETS="dist/csp-docs.zip"
[ -f dist/policy-ddf.zip ] && ASSETS="$ASSETS dist/policy-ddf.zip"
gh release create latest $ASSETS --title "Latest CSP Docs" --notes "${{ steps.summary.outputs.notes }}"
```

Delete-then-create is the simplest way to keep a moving `latest` tag. Alternatives considered and rejected:

- `gh release edit` — GitHub's asset upload API doesn't cleanly replace assets; old ones linger.
- Incremental tags (`v2026.04.24-a1b2c3`) — breaks the stable-URL promise, forces consumers to discover the current version.
- `actions/create-release` — deprecated; behaviour similar to our approach.

**Failure window:** between `gh release delete` and `gh release create`, the `latest` URL is 404 for seconds. Consumers running a build during that window will fail. Mitigation: build output is cached, retries succeed. If this ever becomes a real pain point, migrate to GitHub Pages or a versioned+symlink scheme.

## What a CI failure looks like

| Stage that fails | What the `latest` release looks like | Consumer impact |
|------------------|-------------------------------------|-----------------|
| Checkout / setup-node | No artifact built | Previous release remains; consumers are fine. |
| State cache restore fails | Non-fatal; warn and proceed | Full re-fetch that run. |
| Prior release download fails | Non-fatal; cold start | Full re-fetch that run. |
| `npm ci` | Exit non-zero | Previous release remains; consumers are fine. |
| `npm run build` (fetch/pack) | Exit non-zero | Previous release remains; consumers are fine. |
| `gh release delete` | Either succeeds or `|| true` swallows missing-release | Proceeds. |
| `gh release create` | **If this fails after delete succeeded, `latest` is gone**. | Next workflow run restores it. |

## Observability

- **Run logs** in the Actions tab show the manifest summary line.
- **Release page** shows the date, the notes blurb, and a history of prior builds (each visible under "Releases" though the stable `latest` URL always points at the newest).
- **`state/manifest.json` inside `csp-docs.zip`** exposes `counts.updated` so consumers can detect whether the shipped content actually changed vs. just being re-packed.

## Secrets

None. The workflow uses the built-in `GITHUB_TOKEN` for release operations. No PATs, no third-party integrations, no secret management required.

## Estimated run time

| Scenario | Time |
|----------|------|
| Cold run (fresh cache, no prior release) | ~45s for fetch, ~5s for pack, ~20s for release = ~70s |
| Warm run (all pages `304`, DDF URL unchanged) | ~5s for fetch, ~5s for pack, ~20s for release = ~30s |
| Policy DDF rotation (new monthly zip) | Warm + ~3s DDF download + extract = ~35s |

## Cost

GitHub-hosted `ubuntu-latest` runners; ~30–70 seconds per weekly run = roughly 3 minutes per month. Well within the free tier for public repos.
