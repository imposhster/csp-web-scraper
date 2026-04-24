# Artifact Schemas

Definitive reference for the two published zip artifacts and the internal state files a reimplementation must read and write. Every field listed here is part of the consumer contract — **do not remove or rename fields without coordinating with `cpt-csp-ui`**. Additions are safe.

## `csp-docs.zip`

### Layout

```
csp-docs.zip
├── manifest.json
├── slugs.json
└── pages/
    ├── accountmanagement-csp.md
    ├── accountmanagement-ddf.md
    ├── ...
    └── policy-configuration-service-provider.md
```

All files are UTF-8. The `pages/` subdirectory contains one file per slug. Filenames are `{slug}.md` — no subdirectories, no indirection.

### `manifest.json` schema

```jsonc
{
  "artifact": "csp-docs",                               // constant string
  "generatedAt": "2026-04-24T14:00:00.000Z",            // ISO 8601 UTC, when pack.mjs ran
  "source": "https://learn.microsoft.com/...toc.json",  // TOC URL that drove this build
  "tocFetchedAt": "2026-04-24T13:59:58.000Z",           // when fetch-toc.mjs ran
  "counts": {
    "total": 178,          // total slugs listed by the TOC (after filter)
    "updated": 1,          // this run's 200-OK count from fetch-pages
    "notModified": 177,    // this run's 304 count
    "missing": 0,          // this run's 404 count
    "errors": 0,           // this run's non-retryable-error count
    "filesShipped": 178    // count of .md files actually in the zip (should equal total - missing)
  },
  "missing": [],           // slugs that returned 404; empty in a healthy build
  "pages": [               // sorted list of .md filenames in pages/
    "accountmanagement-csp.md",
    "accountmanagement-ddf.md",
    "...",
    "policy-configuration-service-provider.md"
  ]
}
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `artifact` | string | yes | Discriminator. Always `"csp-docs"` for this zip. |
| `generatedAt` | ISO 8601 UTC string | yes | Freshness check for caching consumers. |
| `source` | URL string | yes | Traceability: which TOC produced these pages. |
| `tocFetchedAt` | ISO 8601 UTC string | yes | Time delta against `generatedAt` tells you how long a build took. |
| `counts.total` | integer | yes | Size of the slug set *before* shipping. |
| `counts.updated` | integer | yes | Telemetry; informational. |
| `counts.notModified` | integer | yes | Telemetry; informational. |
| `counts.missing` | integer | yes | Count matching `missing[]` length. |
| `counts.errors` | integer | yes | Count matching unshown error list (the run would fail if >0, so this is always 0 in a shipped zip). |
| `counts.filesShipped` | integer | yes | Actual count of `pages/*.md` in the zip. |
| `missing[]` | string[] | yes | 404'd slugs. |
| `pages[]` | string[] | yes | Sorted file list. Consumer can cross-check `pages/` dir against this. |

### `slugs.json` schema

```jsonc
{
  "fetchedAt": "2026-04-24T13:59:58.000Z",
  "source": "https://learn.microsoft.com/.../toc.json",
  "count": 178,
  "slugs": [
    "accountmanagement-csp",
    "accountmanagement-ddf",
    "..."
  ]
}
```

This is the same file as `state/slugs.json`, copied into the zip for consumer convenience (so they don't have to derive it from filenames).

### Page files

Each `pages/{slug}.md` is the raw response body from
`https://learn.microsoft.com/en-us/windows/client-management/mdm/{slug}?accept=text/markdown`.

Structure:

```markdown
---
<YAML frontmatter — layout, title, canonicalUrl, ms.date, etc.>
---

# <Human title>

<Prose paragraphs>

```xml
<Optional XML DDF content inside a fenced code block>
```
```

No transformation is applied. Consumer parsing expectations:

- The YAML frontmatter block may be parsed for metadata (`ms.date`, `original_content_git_url`, etc.).
- The body is CommonMark-compatible; fenced code blocks use triple backticks with a language tag.
- XML content inside fenced blocks is well-formed DDF XML (DTD reference at the top).

## `policy-ddf.zip`

### Layout

```
policy-ddf.zip
├── manifest.json
└── extracted/
    ├── AboveLock_AreaDDF.xml
    ├── Accounts_AreaDDF.xml
    ├── ActiveSync.xml
    ├── ...
```

The `extracted/` layout deliberately matches `cpt-csp-ui/backend/data/ddf/extracted/` so the consumer can unzip straight into `data/ddf/` and everything lands in the right place.

### `manifest.json` schema

```jsonc
{
  "artifact": "policy-ddf",                          // constant string
  "generatedAt": "2026-04-24T14:00:05.000Z",         // when pack.mjs ran
  "source": "https://download.microsoft.com/.../DDFv2Feb2026.zip",  // auto-discovered URL
  "upstreamLastModified": "Thu, 19 Feb 2026 18:04:42 GMT",          // from Microsoft's response headers (RFC 1123 format)
  "upstreamEtag": "\"0x8DE...\"",                                    // from Microsoft's response headers; may be null
  "downloadedAt": "2026-04-24T13:59:50.000Z",                        // when we last actually pulled the zip
  "checkedAt": "2026-04-24T14:00:05.000Z",                           // when we last ran the URL-equality check (may differ from downloadedAt if we short-circuited)
  "sourceBytes": 724192,                                             // size of the upstream zip in bytes
  "counts": {
    "xmlFiles": 313                                                  // count of *.xml files in extracted/
  },
  "files": [                                                         // sorted list of files in extracted/
    "AboveLock_AreaDDF.xml",
    "Accounts_AreaDDF.xml",
    "..."
  ]
}
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `artifact` | string | yes | Discriminator. Always `"policy-ddf"`. |
| `generatedAt` | ISO 8601 UTC string | yes | When pack ran. |
| `source` | URL string | yes | Upstream zip URL for traceability. |
| `upstreamLastModified` | RFC 1123 string or null | yes | Microsoft's `Last-Modified` response header. |
| `upstreamEtag` | string or null | yes | Microsoft's `ETag` header. |
| `downloadedAt` | ISO 8601 UTC string | yes | Last actual download. Stays constant when we short-circuit. |
| `checkedAt` | ISO 8601 UTC string | yes | Last time we verified the URL hadn't changed. |
| `sourceBytes` | integer | yes | Zip byte size from upstream. Useful for consumer sanity checks. |
| `counts.xmlFiles` | integer | yes | How many XMLs to expect in `extracted/`. |
| `files[]` | string[] | yes | Sorted file list; consumer can cross-check. |

### XML files

Each `extracted/{name}.xml` is a Microsoft DDF XML document. Structure follows the DDF v2 schema (defined in the `configuration-service-provider-ddf` Learn page, which ships in `csp-docs.zip`). Typical root:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE MgmtTree PUBLIC "-//OMA//DTD-DM-DDF 1.2//EN" "...">
<MgmtTree xmlns:MSFT="http://schemas.microsoft.com/MobileDevice/DM">
  <VerDTD>1.2</VerDTD>
  <Node>
    <NodeName>...</NodeName>
    ...
  </Node>
</MgmtTree>
```

The scraper does **not** validate XML. Downstream consumers are expected to parse it (`cpt-csp-ui` uses `xml2js`).

## State files (internal)

These live in `state/` and are not published — but a reimplementation must read and write them with equivalent shapes to preserve change-detection behavior.

### `state/slugs.json`

Identical shape to the `slugs.json` inside the zip. Written by `fetch-toc.mjs`, read by `fetch-pages.mjs` and `pack.mjs`.

### `state/manifest.json` (markdown fetch state)

```jsonc
{
  "generatedAt": "2026-04-24T14:00:02.000Z",
  "source": "https://learn.microsoft.com/.../toc.json",
  "tocFetchedAt": "2026-04-24T13:59:58.000Z",
  "durationMs": 7436,
  "counts": {
    "total": 178,
    "updated": 1,
    "notModified": 177,
    "missing": 0,
    "errors": 0
  },
  "pages": {
    "accountmanagement-csp": {
      "lastModified": "Fri, 14 Feb 2026 23:46:00 GMT",
      "etag": "\"W/...\"",
      "bytes": 12345
    }
    // ... one entry per successfully-fetched slug
  },
  "missing": [],
  "errors": []
}
```

| Field | Type | Purpose |
|-------|------|---------|
| `pages[slug].lastModified` | RFC 1123 string or null | Next run sends this as `If-Modified-Since`. |
| `pages[slug].etag` | string or null | Next run sends this as `If-None-Match`. |
| `pages[slug].bytes` | integer | Telemetry. |
| `missing[]` | string[] | 404'd slugs; exists for observability. |
| `errors[]` | object[] | Non-retryable errors; run fails with exit 2 when non-empty. Each entry is `{slug, status}` or `{slug, message}`. |

### `state/policy-ddf/state.json` (DDF state)

```jsonc
{
  "discoveredUrl": "https://download.microsoft.com/.../DDFv2Feb2026.zip",
  "downloadedAt": "2026-04-24T13:59:50.000Z",
  "checkedAt": "2026-04-24T14:00:02.000Z",
  "sourceBytes": 724192,
  "lastModified": "Thu, 19 Feb 2026 18:04:42 GMT",
  "etag": "\"0x8DE...\"",
  "xmlCount": 313
}
```

The **primary change-detection signal** is `discoveredUrl`: if the newly discovered URL string equals the one stored here AND `state/policy-ddf/extracted/` is non-empty, the entire download+extract is skipped.

### `state/policy-ddf/extracted/*.xml`

Flattened XML files. Repopulated on any non-skip run. Becomes `policy-ddf.zip`'s `extracted/` on pack.

## Field ordering and whitespace

JSON is pretty-printed with 2-space indentation and LF line endings. Field order is not contractually specified, but the current implementation emits fields in the order shown above. Consumers must not depend on field ordering.

## Versioning

Neither zip carries a version field. The filenames are stable, the URLs are stable, and the schemas evolve additively. If a breaking change is ever needed (e.g. renaming `artifact`), the path forward is a new zip name (e.g. `csp-docs-v2.zip`) attached to the same release alongside the old one during a transition period.
