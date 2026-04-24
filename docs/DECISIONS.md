# Design Decisions (ADR Log)

Lightweight architecture decision records. Each entry captures context, the decision, and its consequences — so reviewers porting or extending the system understand *why* each choice was made, not just *what* the code does.

---

## ADR-001: Node.js for the initial implementation

**Context.** The first consumer, `cpt-csp-ui`, is a Node.js project (`type: "module"`, Express backend, React frontend). Its existing DDF ingestion is Node (`https`, `xml2js`, `unzipper`). A new scraping tool could have been any language.

**Decision.** Node.js ESM, Node 20+, with stdlib-only runtime dependencies (`adm-zip` dev-only for packing).

**Consequences.**
- ✅ Zero friction for the one developer maintaining both projects today.
- ✅ Shared patterns with the existing `download-ddf.mjs`.
- ✅ Easy local testing on Windows/macOS/Linux.
- ⚠️ A future team with no Node background has to port or accept it — see `REIMPLEMENTATION.md`.

---

## ADR-002: GitHub Releases as the distribution channel

**Context.** The output has to be reachable from `cpt-csp-ui` (and future consumers) via a URL that:
- Is stable (consumer shouldn't hard-code a version).
- Requires no auth.
- Can be served for free.

Options considered: GitHub Artifacts (expire in 90 days, require auth), GitHub Pages (works but more setup), GitHub Releases `latest` tag (stable-ish URL by convention), S3 / Cloudflare R2 (costs, extra account).

**Decision.** GitHub Releases with a `latest` tag, deleted and re-created on every run. The URL pattern `https://github.com/<owner>/<repo>/releases/latest/download/<asset>` works anonymously for public repos.

**Consequences.**
- ✅ No extra infrastructure.
- ✅ Web UI shows a human-readable history of runs.
- ✅ `gh release download` makes local testing easy.
- ⚠️ Brief 404 window during delete-then-create. Acceptable; consumers with retries are unaffected.
- ⚠️ Tied to public-repo visibility for the no-auth promise. See ADR-003.

---

## ADR-003: Repository is public

**Context.** The content is 100% republished Microsoft public documentation. Source material: `learn.microsoft.com/en-us/windows/client-management/mdm/*`. The scraper has no proprietary logic that reveals business intent; the parsing rules are specific to Microsoft's TOC and DDF formats.

**Decision.** Make the repo public. The `latest` release URL is accessible to anonymous `curl` / `HttpClient`.

**Consequences.**
- ✅ Consumers integrate with one `GET`, no tokens, no secrets.
- ✅ Lower operational risk — no PAT to rotate, no credential leak blast radius.
- ⚠️ The scraping implementation is visible to anyone. We judged this fine; there's nothing sensitive here.
- If the scraper is ever extended to touch non-public sources, reassess.

---

## ADR-004: Auto-discover the DDF zip URL

**Context.** Microsoft rotates the Policy DDF zip URL monthly (`DDFv2Feb2026.zip` → `DDFv2Mar2026.zip`). The prior approach in `cpt-csp-ui/backend/scripts/download-ddf.mjs` hard-coded a single URL; someone had to manually update it every month.

The scraper already downloads the `configuration-service-provider-ddf` overview page — the same page that contains the current URL as its first bullet.

**Decision.** Parse the current URL out of the scraped markdown via regex. The regex is tightly scoped to `[DDF v2 Files ...](https://download.microsoft.com/...*.zip)` — it does not match the "Older DDF files" archive links or the separate `PolicyDDF_all.xml` links.

**Consequences.**
- ✅ No manual URL maintenance.
- ✅ Works monthly forever as long as Microsoft keeps the page format.
- ⚠️ If Microsoft changes the link text or structure, the run fails loudly with a clear error. Acceptable — better than silently serving a stale zip.
- The scraper is now stateful *about the upstream URL*: it remembers the last-seen URL to detect monthly rotation.

---

## ADR-005: Policy subtree exclusion scope

**Context.** The Policy CSP has two documentation surfaces:
1. A prose overview page describing what Policy CSP is and how to address its nodes.
2. ~200 per-area pages (`policy-csp-abovelock`, `policy-csp-accounts`, etc.) that are programmatically generated from the DDF XML.

The DDF zip already contains the XML for (2). Including those 200 markdown pages in `csp-docs.zip` would triple its size with redundant information.

**Decision.** Explicit allowlist for `policy-configuration-service-provider` (the overview). Prefix-exclude everything else matching `policy-*`. Non-Policy CSPs with "Policy" in the name (`cmpolicy-csp`, `networkqospolicy-csp`, etc.) are preserved because their slugs don't match the `policy-` prefix.

**Consequences.**
- ✅ csp-docs.zip stays small (~0.8 MB vs. potentially ~3 MB).
- ✅ No duplication between the two artifacts.
- ✅ Downstream consumers get the Policy prose for LLM context + the DDF XML for schema parsing — both needed, neither redundant.
- ⚠️ The allowlist is a single string; adding more Policy subtree pages (if Microsoft ever introduces e.g. a "Policy admin guide") requires a code change.

---

## ADR-006: Change detection via conditional HTTP + URL equality

**Context.** Running the pipeline weekly against ~178 pages would re-download ~30 MB of markdown for essentially no data changes on most weeks. The DDF zip (~0.7 MB) rarely changes within a month.

Options considered: content hashing (requires full download anyway), file mtime (not available over HTTP), `If-Modified-Since` / `ETag` headers (supported by Microsoft Learn).

**Decision.**
- For markdown: `If-Modified-Since` and `If-None-Match` per slug. 304 responses cost ~100 bytes each.
- For DDF zip: compare discovered URL against prior state. URL equality ⇒ no change. Skip even the HEAD request.

**Consequences.**
- ✅ Warm runs finish in ~2s with near-zero upstream load.
- ✅ Consumers reading `manifest.counts.updated` can detect whether a rebuild actually contains new content.
- ⚠️ Loses correctness if Microsoft serves stale `Last-Modified` headers. Accept the risk — weekly cadence is tolerant of a week's staleness, and a manual `workflow_dispatch` with `CSP_FORCE_REFRESH=1` is the escape hatch.

---

## ADR-007: Flatten XML extraction to basename-only

**Context.** Microsoft's DDF zips have varied internal structure over the years — sometimes `DDFv2/*.xml`, sometimes `extracted/*.xml`, sometimes root-level. The existing consumer (`cpt-csp-ui`) expects a flat `data/ddf/extracted/` directory.

**Decision.** When extracting, take the basename of each `*.xml` entry; ignore directory entries; ignore non-XML entries; flatten into `state/policy-ddf/extracted/` with no subdirectories.

**Consequences.**
- ✅ Consumer-side layout is stable regardless of upstream changes.
- ✅ Simpler to reason about — the extracted dir is always "a pile of XML files, named whatever Microsoft named them."
- ⚠️ If Microsoft ever ships two XML files with colliding basenames in nested folders, the second silently overwrites the first. Not observed in practice; worth monitoring.

---

## ADR-008: Two artifacts, not one

**Context.** We could ship one combined `csp-docs-and-policy-ddf.zip` containing both markdown and XML.

**Decision.** Two separate artifacts: `csp-docs.zip` and `policy-ddf.zip`.

**Consequences.**
- ✅ Consumers pull only what they need — a markdown-only chatbot doesn't download 313 XML files.
- ✅ Clean cadence separation — if the DDF doesn't change this month, consumers can tell without unzipping.
- ✅ Each has its own typed `manifest.json`.
- ⚠️ Two downloads instead of one for consumers that want everything. Negligible — total is ~1.5 MB.

---

## ADR-009: Pack at the end rather than stream-write

**Context.** The alternative design streams each page directly into `csp-docs.zip` as it's fetched, avoiding an intermediate `output/` directory.

**Decision.** Fetch writes to `output/*.md`. A separate `pack.mjs` step zips at the end.

**Consequences.**
- ✅ Restartable: if packing fails (disk full, etc.), the pages are intact on disk and the next run continues from where it left off.
- ✅ Dev ergonomics: `CSP_SKIP_FETCH=1` lets the author iterate on the pack step without re-hitting Microsoft.
- ✅ State restoration from the prior release restores `output/` directly — no unpack-repack dance.
- ⚠️ Two-phase I/O is slightly more work. Tradeoff is cheap.

---

## ADR-010: Single fixed worker pool size (8)

**Context.** Concurrency could be adaptive (back off on 429s, ramp up when fast), configurable per page, or fixed.

**Decision.** Fixed at 8, overridable via `CSP_MAX_CONCURRENCY` for emergencies.

**Consequences.**
- ✅ Simple. Predictable load on Microsoft. ~10s for 178 pages is fast enough.
- ✅ No observed 429s at this rate.
- Revisit if Microsoft ever pushes back. The retry logic handles transient backpressure already.

---

## ADR-011: No retries at the TOC level

**Context.** `fetch-pages.mjs` retries transient errors up to 3 times. `fetch-toc.mjs` does not.

**Decision.** If `toc.json` fetch fails, fail the whole run immediately.

**Consequences.**
- ✅ Loud fail surfaces real outages rather than masking them.
- ✅ The TOC is a single request; re-running the workflow by hand is easy.
- ⚠️ A flake during `fetch-toc.mjs` wastes that weekly run. Acceptable given `workflow_dispatch` is available.

---

## ADR-012: Kotlin/JVM port is the likely successor

**Context.** The owning organization's development team is Java/Kotlin-centric. Node.js is a pragmatic choice for the initial author but a long-term maintenance burden for a team that doesn't use it elsewhere.

**Decision.** Design the consumer contract (URLs, zip layouts, JSON schemas) to be language-agnostic. Keep Node-specific idioms out of the observable artifacts. Document the reimplementation path explicitly (`REIMPLEMENTATION.md`).

**Consequences.**
- ✅ A port can drop in behind the same URLs with zero consumer changes.
- ✅ Diffing implementations is a mechanical check (unzip, compare files).
- Current Node implementation is treated as a reference implementation rather than the canonical one.
