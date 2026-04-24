# Parsing and Filtering

This document specifies every piece of upstream-content parsing in the pipeline. The parsing rules here are the actual business logic — change them with care, and preserve them exactly in any port.

## TOC tree walk

**Input:** `toc.json` parsed as a JavaScript/Java object.
**Output:** a `Set<String>` of slugs to fetch.

### Algorithm

```
function walk(node, acc):
    if node is null or not an object:
        return
    if node is an array:
        for each element e in node:
            walk(e, acc)
        return
    if node has a string field "href":
        slug = normalize(node.href)
        if slug is non-null and not excluded:
            acc.add(slug)
    for each key in ["items", "children", "toc"]:
        if node has that key:
            walk(node[key], acc)
```

Three container keys are checked because Microsoft's TOC uses different names at different depths. This is a **union**, not a fallback — nodes may legally carry multiple of them (though in practice they don't).

### Slug normalization

Input hrefs are inconsistent — relative (`./foo`), bare (`foo`), with extension (`foo.md`), with fragment (`foo#section`), with query, or absolute. The normalizer returns a bare slug or `null`.

```
function normalize(href):
    h = trim(href)
    if h is empty: return null
    if h starts with "http:" or "https:" (case-insensitive): return null
    if h starts with "#": return null
    if h starts with "./": strip "./"
    if h starts with "../" or "/": return null
    strip everything from first "#" or "?"
    if h ends with ".md" (case-insensitive): strip ".md"
    if h is empty after stripping: return null
    if h does not match /^[a-z0-9][a-z0-9_-]*$/i: return null
    return h
```

Rejecting absolute URLs and `../` prevents accidental inclusion of cross-area pages.

### Slug filter (Policy subtree exclusion)

```
POLICY_ALLOWLIST = { "policy-configuration-service-provider" }

function isExcluded(slug):
    if slug in POLICY_ALLOWLIST: return false   # explicit keep
    if slug starts with "policy-": return true   # drop the rest of the subtree
    return false
```

The scope is:

- **Kept, Policy overview:** `policy-configuration-service-provider` (the one prose page describing what Policy CSP is).
- **Dropped:** `policy-csp` (landing page), `policy-csp-{area}` (~200 per-area pages), `policy-ddf-file` (the DDF-as-markdown page). These are represented in the separate `policy-ddf.zip` as XML.
- **Kept, non-Policy CSPs with "Policy" in the name:** `cmpolicy-csp`, `cmpolicyenterprise-csp`, `networkqospolicy-csp`, `tpmpolicy-csp`, `securitypolicy-csp`. These do NOT match the `policy-` prefix because the `-` comes later.

### Output

`state/slugs.json`:

```json
{
  "fetchedAt": "2026-04-24T14:00:00.000Z",
  "source": "https://learn.microsoft.com/en-us/windows/client-management/mdm/toc.json",
  "count": 178,
  "slugs": ["accountmanagement-csp", "accountmanagement-ddf", ...]
}
```

Slug list is sorted to produce stable diffs across runs.

### Invariant check

After filtering, the walker verifies no slug matches `/^policy-/` other than the allowlisted one. If any does, it throws — the filter is incorrect.

## Slug naming inconsistencies

Microsoft uses different suffixes for the DDF page per CSP:

| Pattern | Examples |
|---------|----------|
| `-ddf` | `accountmanagement-ddf`, `alljoynmanagement-ddf`, `bitlocker-ddf` does **NOT** exist |
| `-ddf-file` | `accounts-ddf-file`, `activesync-ddf-file`, `applocker-ddf-file`, `bitlocker-ddf-file` |
| `-csp-ddf` | `applicationcontrol-csp-ddf` |
| `language-pack-management-csp` | Includes hyphens inside the name |

**Do not** assume a naming pattern when enumerating pages. The TOC is authoritative — take whatever slugs it gives us and fetch them.

## DDF zip URL discovery

**Input:** `output/configuration-service-provider-ddf.md` (saved earlier by `fetch-pages.mjs`).
**Output:** a URL string pointing at the current month's Policy DDF zip.

### Regex

```
/\[\s*DDF v2 Files[^\]]*\]\((https:\/\/download\.microsoft\.com\/[^)\s]+\.zip)\)/i
```

Capture group 1 is the URL. Matches the first occurrence in document order — this is deliberate. Microsoft lists the current month first, then "Older DDF files" as a historical archive below. Taking the first match always gives us the current month.

### Test fixtures

Positive matches:
```markdown
- [DDF v2 Files, February 2026](https://download.microsoft.com/download/015bd9f5-9cca-4821-8a85-a4c5f9a5d0f2/DDFv2Feb2026.zip)
- [ DDF v2 Files, September 2025 ](https://download.microsoft.com/download/.../DDFv2Sept25.zip)
```

Negative matches (intentionally not captured):
```markdown
- [Download all the DDF files for Windows 10, version 2004](https://download.microsoft.com/.../Windows10_2004_DDF_download.zip)
- [View the Policy DDF file for Windows 10, version 1607](https://download.microsoft.com/.../PolicyDDF_all_version1607.xml)
```

The `DDF v2 Files` literal is what distinguishes the "current combined zip" from all the older per-version archives.

### Failure mode

Regex miss throws `Failed to parse DDF zip URL from output/configuration-service-provider-ddf.md. Microsoft may have changed the page format.` The run fails before writing anything. The prior `latest` release on GitHub is untouched.

## DDF zip extraction

**Input:** downloaded zip body (Buffer).
**Output:** flat files in `state/policy-ddf/extracted/*.xml`.

### Algorithm

```
function extract(zipBuffer):
    rm -rf state/policy-ddf/extracted/
    mkdir state/policy-ddf/extracted/
    count = 0
    for each entry in zip:
        if entry is a directory: continue
        if entry.name does not end with ".xml" (case-insensitive): continue
        write state/policy-ddf/extracted/<basename(entry.name)> <- entry.bytes
        count += 1
    if count == 0: throw
    return count
```

### Why basename flattening

Microsoft's zips have used varied internal layouts across years. Flattening ensures the output is always `state/policy-ddf/extracted/{filename}.xml` regardless of whether the source had `DDFv2/{filename}.xml`, `extracted/{filename}.xml`, or a root-level layout. The consumer (`cpt-csp-ui`) expects a flat dir.

### Collision handling

If two entries share a basename (e.g. `foo/A.xml` and `bar/A.xml`), the second overwrites the first. This has not been observed in practice. A port may want to reject duplicates defensively.

## Markdown handling (none)

The scraper **does not parse markdown bodies**. It treats the response as an opaque byte stream and writes it verbatim to `output/{slug}.md`. This means:

- YAML frontmatter is preserved (downstream consumers can parse it if they want).
- Fenced XML blocks inside markdown are preserved verbatim.
- Encoding is whatever Microsoft sends (UTF-8 in all observed cases).
- Line endings are whatever Microsoft sends (LF in all observed cases).

Consumers that want structured data from individual pages are expected to parse the markdown themselves.

## XML handling (none)

The scraper does not parse the extracted DDF XML. The consumer (`cpt-csp-ui/backend/scripts/build-catalog.mjs`) parses it using `xml2js`. A Java/Kotlin port of this scraper should continue to treat XML as opaque bytes.

## JSON handling

Two JSON files are parsed as input:

- `toc.json` (upstream) — standard JSON, parse with stdlib.
- `state/manifest.json` / `state/policy-ddf/state.json` (self-produced) — always well-formed, but tolerate missing files (first run) by falling back to empty state.

Output JSON (the manifests inside each zip) must be:

- UTF-8 (no BOM)
- 2-space indented, human-readable
- Field order is not part of the contract, but prefer consistent ordering to produce small diffs between runs.
