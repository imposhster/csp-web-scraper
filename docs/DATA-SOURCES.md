# Data Sources

Every external input to the pipeline, what we request, and how we interpret the response. The scraper is strictly read-only against Microsoft — it never POSTs, authenticates, or submits forms.

## 1. Microsoft Learn TOC JSON

| Attribute | Value |
|-----------|-------|
| URL | `https://learn.microsoft.com/en-us/windows/client-management/mdm/toc.json` |
| Override env var | `CSP_TOC_URL` |
| Method | GET |
| Auth | None (public) |
| Expected status | 200 OK |
| Response body | JSON |
| Expected size | ~100 KB |

### Structure (observed)

The TOC is a recursive tree. The same semantic ("child nodes") appears under several different key names at different depths, so the walker must check all of them:

```jsonc
{
  "items": [
    {
      "toc_title": "Configuration service providers (CSPs)",
      "children": [
        {
          "toc_title": "Policy",
          "href": "policy-configuration-service-provider",
          "children": [
            { "toc_title": "Policy CSP DDF file", "href": "policy-ddf-file" },
            {
              "toc_title": "Policy CSP areas",
              "children": [
                { "toc_title": "AboveLock", "href": "policy-csp-abovelock" }
                // ... ~200 more policy-csp-* entries
              ]
            }
          ]
        },
        {
          "toc_title": "AccountManagement",
          "children": [
            { "toc_title": "AccountManagement", "href": "accountmanagement-csp" },
            { "toc_title": "AccountManagement DDF file", "href": "accountmanagement-ddf" }
          ]
        }
        // ... ~75 more CSPs
      ]
    }
  ]
}
```

### Fields we read

| Field | Type | Used for |
|-------|------|----------|
| `href` | string (relative slug, may have `./` prefix or `.md` suffix) | Page URL construction |
| `items[]` / `children[]` / `toc[]` | array of node | Recursion |

All other TOC fields (`toc_title`, `expanded`, `maintainContext`, etc.) are **ignored**.

### Assumptions

- The JSON is well-formed and parseable. A parse failure is treated as a run-level failure.
- The tree is a pure tree (no cycles). We do not track visited nodes.
- Container key names may vary; walker handles `items`, `children`, and `toc` uniformly.

## 2. Microsoft Learn page-as-markdown

| Attribute | Value |
|-----------|-------|
| URL template | `https://learn.microsoft.com/en-us/windows/client-management/mdm/{slug}?accept=text/markdown` |
| Override env var | `CSP_MDM_BASE_URL` (base only, the `/{slug}?accept=...` part is built by `paths.mjs`) |
| Method | GET |
| Auth | None |
| Expected status | 200 OK, 304 Not Modified, 3xx redirect, occasional 404 |

### Request headers we send

| Header | Value | Why |
|--------|-------|-----|
| `User-Agent` | `csp-web-scraper (+https://github.com/)` | Identifies us in Microsoft's access logs — minimally courteous. |
| `Accept-Encoding` | `identity` | We don't implement gzip decoding in the stdlib client; identity keeps the body readable. |
| `If-Modified-Since` | Prior run's `Last-Modified` for this slug, if any | Triggers 304 when the page is unchanged. |
| `If-None-Match` | Prior run's `ETag` for this slug, if any | Secondary conditional signal. |

### Response body

Plain text, UTF-8, Markdown. Starts with a YAML frontmatter block delimited by `---` lines. Example:

```markdown
---
layout: Conceptual
title: AccountManagement DDF file | Microsoft Learn
canonicalUrl: https://learn.microsoft.com/...
ms.date: 2025-02-13T00:00:00.0000000Z
original_content_git_url: https://github.com/MicrosoftDocs/windows-docs-pr/...
---

# AccountManagement DDF file | Microsoft Learn

...

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MgmtTree ...>
...
</MgmtTree>
```
```

The scraper **does not parse markdown**. The body is saved byte-for-byte as `output/{slug}.md`.

### Status code handling

| Status | Action |
|--------|--------|
| 200 | Save body; record `last-modified`, `etag`, `bytes` in manifest. |
| 304 | Skip write; preserve prior manifest entry. If the local file is missing (e.g. fresh runner without cache), force-refetch the slug once with no conditional headers. |
| 301/302/303/307/308 | Follow redirect up to 5 hops. |
| 404 | Record in `manifest.missing[]`. Delete the local file if present so the zip doesn't ship removed pages. |
| 429 / 5xx | Exponential backoff: 1s, 2s, 4s. Max 3 attempts. |
| Anything else | Record in `manifest.errors[]`; exit code 2 after all slugs processed. |

### Rate limits

Microsoft Learn does not publish rate limits for anonymous markdown requests. Empirically, 8 concurrent in-flight requests for ~180 pages completes cleanly in ~10s with zero 429s. The retry logic is defensive.

## 3. Microsoft download CDN (Policy DDF zip)

| Attribute | Value |
|-----------|-------|
| URL | **Auto-discovered** — see below. Current: `https://download.microsoft.com/download/015bd9f5-9cca-4821-8a85-a4c5f9a5d0f2/DDFv2Feb2026.zip` |
| URL rotation | Monthly. The filename changes (`DDFv2Mar2026.zip`, etc.); the path stem appears stable but is not guaranteed. |
| Override env var | None at the scraper level. The consumer has `POLICY_DDF_URL` for pointing at our mirrored zip. |
| Method | GET |
| Auth | None |
| Expected status | 200 OK (typically via one or more 3xx redirects to a CDN host) |
| Response body | Binary (ZIP) |
| Expected size | ~0.7 MB (2026-02 baseline; varies by month) |

### URL discovery

Parsed from the scraped `configuration-service-provider-ddf.md` (the DDF overview page). The first matching link wins:

```
Regex: /\[\s*DDF v2 Files[^\]]*\]\((https:\/\/download\.microsoft\.com\/[^)\s]+\.zip)\)/i
```

Matches e.g.:

```markdown
- [DDF v2 Files, February 2026](https://download.microsoft.com/download/015bd9f5-9cca-4821-8a85-a4c5f9a5d0f2/DDFv2Feb2026.zip)
```

**Failure mode:** regex miss throws with a clear error; the run fails before touching the prior release. Microsoft changing the link format on the overview page would be the trigger.

### Zip contents (observed over time)

The internal structure of the DDF zip has varied across Microsoft releases:

- 2026-02: flat — all XML files at the zip root
- Older zips: sometimes nested under a top-level folder, sometimes with other formats (PDFs, DTDs)

**Our handling:** iterate every entry, keep only `*.xml`, extract with basename only (no subdirectories). Non-XML entries are ignored without warning. Zero XML files is a fatal error.

### No conditional requests

The download CDN does not reliably support `If-Modified-Since` across redirects, and URL rotation is a much stronger change signal anyway. We compare the discovered URL against `state.discoveredUrl` from the prior run and short-circuit before any network call when they match.

## HTTP client requirements (summary)

Any reimplementation must provide, at minimum:

- HTTPS with valid public CA trust
- Follow 3xx redirects (handle cross-host redirects — the download CDN does this)
- Send configurable request headers (User-Agent, conditional request headers)
- Read `Last-Modified` and `ETag` response headers
- Handle binary (zip) and text (markdown, JSON) response bodies
- Reasonable timeouts (not currently enforced in Node version — reimplementations should add ~30s read timeout)
- Support at least 8 concurrent in-flight requests (tunable)

## What we do NOT use

Explicitly out of scope, to avoid scope creep or brittle dependencies:

- Microsoft Learn's search or recommendation APIs
- The GitHub source repos for Microsoft docs (`MicrosoftDocs/windows-docs-pr` — private) or any public mirror (`MicrosoftDocs/windows-itpro-docs`, etc.)
- Microsoft Graph / Intune Graph APIs
- Any authenticated endpoint
- PDF renditions (`pdf_url_template` exists in the frontmatter but we don't use it)
