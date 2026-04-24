# Reimplementation Guide (Java / Kotlin)

This document targets a team porting `csp-web-scraper` from Node.js to the JVM. It calls out what behaviors are part of the contract (must preserve) vs. what's implementation detail (replace freely), gives library recommendations, and translates each algorithm into Kotlin-flavored pseudocode.

## Preserve vs. replace

### Must preserve (consumer contract)

These are observable to `cpt-csp-ui` and any future consumer. Changing them breaks downstream:

- **Release artifact names**: `csp-docs.zip` and `policy-ddf.zip`.
- **Release URL pattern**: `https://github.com/imposhster/csp-web-scraper/releases/latest/download/{name}.zip`.
- **Zip layouts**: see `ARTIFACT-SCHEMAS.md`. Pages at `pages/{slug}.md`, XMLs at `extracted/{basename}.xml`, manifests at root.
- **Manifest JSON schemas**: field names, types, and semantics as documented.
- **Scope rules**: Policy overview page in; all other `policy-*` out; non-Policy CSPs with "Policy" in the name (e.g. `cmpolicy-csp`) in.
- **Encoding**: UTF-8, no BOM, throughout.
- **Weekly build cadence**: consumers assume at-most-weekly update but can read `generatedAt` for fine-grained freshness.

### Safe to replace (implementation detail)

- Language, runtime, dependency set.
- Concurrency primitive (worker pool vs. coroutines vs. virtual threads).
- Zip library.
- HTTP client library.
- JSON library.
- Working directory names (`state/`, `output/`, `dist/`) — not externally visible.
- State file shapes (only `state/slugs.json` is published; the others are internal).
- Retry/backoff strategy — as long as it's reasonable and eventually gives up rather than looping.
- Build tool (Gradle vs. Maven).

## Recommended stack

| Concern | Recommendation | Alternatives |
|---------|----------------|--------------|
| Language | **Kotlin 2.x** on JDK 21+ | Java 21+; Scala 3 |
| HTTP client | **`java.net.http.HttpClient`** (JDK built-in, supports HTTP/2 + redirects) | OkHttp, Apache HttpClient 5 |
| JSON | **Jackson** (`jackson-module-kotlin`) for write ergonomics | Moshi, kotlinx.serialization |
| Zip | **`java.util.zip.ZipInputStream` / `ZipOutputStream`** (stdlib) | Apache Commons Compress (for better large-file support and codec breadth) |
| Concurrency | **`kotlinx.coroutines`** with a bounded dispatcher, or JDK 21+ virtual threads directly | `CompletableFuture` + `ExecutorService`; Reactor |
| Build | **Gradle Kotlin DSL**, Application plugin for the CLI, shadowJar for the artifact | Maven |
| CLI | **`com.github.ajalt.clikt`** for argument parsing | picocli; plain `args: Array<String>` |
| Testing | **JUnit 5** + **Kotest assertions** + **MockWebServer** for HTTP integration tests | Spock (Groovy) |

Do not introduce a reactive streams framework (Reactor, RxJava) for this workload. The problem is naturally batch — iterate slugs, download concurrently, write files. Coroutines or virtual threads are the right fit.

## Suggested project structure

```
csp-web-scraper-jvm/
├── build.gradle.kts
├── settings.gradle.kts
├── src/main/kotlin/com/zettabyte/cspscraper/
│   ├── Main.kt                         # CLI entrypoint, routes to fetchToc / fetchPages / fetchPolicyDdf / pack / build
│   ├── Paths.kt                        # all URL + Path constants; reads env
│   ├── Http.kt                         # HttpClient wrapper
│   ├── toc/
│   │   ├── TocFetcher.kt               # runs the TOC fetch + filter
│   │   ├── SlugNormalizer.kt           # normalize()
│   │   └── PolicyFilter.kt             # isExcluded()
│   ├── pages/
│   │   ├── PageFetcher.kt              # concurrent fetch
│   │   └── Manifest.kt                 # data class + Jackson bindings
│   ├── ddf/
│   │   ├── DdfUrlDiscoverer.kt         # regex parse
│   │   ├── DdfFetcher.kt               # download + extract + state
│   │   └── DdfState.kt
│   └── pack/
│       └── Packer.kt                   # builds both zips
├── src/test/kotlin/...
└── src/test/resources/
    ├── fixtures/toc.json               # a saved TOC snapshot for unit tests
    └── fixtures/ddf-overview.md        # saved DDF overview for URL regex tests
```

## Algorithm translations

### TOC walk + filter

```kotlin
object PolicyFilter {
    private val allowlist = setOf("policy-configuration-service-provider")

    fun isExcluded(slug: String): Boolean {
        if (slug in allowlist) return false
        return slug.startsWith("policy-")
    }
}

object SlugNormalizer {
    private val validSlugRegex = Regex("^[a-z0-9][a-z0-9_-]*$", RegexOption.IGNORE_CASE)

    fun normalize(href: String): String? {
        var h = href.trim().ifEmpty { return null }
        if (h.startsWith("http:", ignoreCase = true)) return null
        if (h.startsWith("https:", ignoreCase = true)) return null
        if (h.startsWith("#")) return null
        if (h.startsWith("./")) h = h.removePrefix("./")
        if (h.startsWith("../") || h.startsWith("/")) return null
        h = h.substringBefore('#').substringBefore('?')
        h = h.removeSuffix(".md").removeSuffix(".MD")
        if (h.isEmpty()) return null
        if (!validSlugRegex.matches(h)) return null
        return h
    }
}

class TocWalker(private val mapper: ObjectMapper) {
    fun collect(root: JsonNode): List<String> {
        val out = sortedSetOf<String>()
        walk(root, out)
        return out.toList()
    }

    private fun walk(node: JsonNode, out: MutableSet<String>) {
        if (node.isArray) {
            node.forEach { walk(it, out) }
            return
        }
        if (!node.isObject) return
        node.get("href")?.takeIf { it.isTextual }?.asText()?.let { href ->
            SlugNormalizer.normalize(href)?.let { slug ->
                if (!PolicyFilter.isExcluded(slug)) out.add(slug)
            }
        }
        for (key in listOf("items", "children", "toc")) {
            node.get(key)?.let { walk(it, out) }
        }
    }
}
```

### Concurrent page fetch with conditional requests

Recommended JDK 21+ approach using virtual threads + a semaphore for in-flight limiting:

```kotlin
class PageFetcher(
    private val http: HttpClient,
    private val prior: Map<String, PageState>,
    private val maxConcurrency: Int = 8,
) {
    private val semaphore = Semaphore(maxConcurrency)

    suspend fun fetchAll(slugs: List<String>): FetchResult = coroutineScope {
        val tasks = slugs.map { slug ->
            async(Dispatchers.IO) {
                semaphore.acquire()
                try {
                    fetchOne(slug, prior[slug])
                } finally {
                    semaphore.release()
                }
            }
        }
        tasks.awaitAll().toFetchResult()
    }

    private fun fetchOne(slug: String, priorEntry: PageState?): PageOutcome {
        val url = "${Paths.mdmBaseUrl}/$slug?accept=text/markdown"
        val req = HttpRequest.newBuilder(URI(url))
            .header("User-Agent", Http.USER_AGENT)
            .header("Accept-Encoding", "identity")
            .apply {
                priorEntry?.lastModified?.let { header("If-Modified-Since", it) }
                priorEntry?.etag?.let { header("If-None-Match", it) }
            }
            .GET()
            .build()

        return retryOnTransient {
            val res = http.send(req, HttpResponse.BodyHandlers.ofByteArray())
            when (res.statusCode()) {
                200 -> PageOutcome.Updated(
                    body = res.body(),
                    lastModified = res.firstHeader("Last-Modified"),
                    etag = res.firstHeader("ETag"),
                )
                304 -> PageOutcome.NotModified
                404 -> PageOutcome.Missing
                in 500..599, 429 -> throw TransientHttpError(res.statusCode())
                else -> PageOutcome.Error(res.statusCode())
            }
        }
    }
}
```

`retryOnTransient` is a small helper that retries up to 3 times with exponential backoff (1s, 2s, 4s) only for `TransientHttpError`.

### DDF URL discovery

The regex transfers directly — identical syntax:

```kotlin
object DdfUrlDiscoverer {
    private val pattern = Regex(
        """\[\s*DDF v2 Files[^\]]*\]\((https://download\.microsoft\.com/[^)\s]+\.zip)\)""",
        RegexOption.IGNORE_CASE,
    )

    fun discover(markdown: String): String {
        val match = pattern.find(markdown)
            ?: throw IllegalStateException(
                "Failed to parse DDF zip URL from overview markdown. Microsoft may have changed the page format."
            )
        return match.groupValues[1]
    }
}
```

### DDF zip extraction (flatten)

```kotlin
fun extractFlat(zipBytes: ByteArray, targetDir: Path): Int {
    targetDir.toFile().deleteRecursively()
    Files.createDirectories(targetDir)
    var count = 0
    ZipInputStream(ByteArrayInputStream(zipBytes)).use { zin ->
        var entry = zin.nextEntry
        while (entry != null) {
            if (!entry.isDirectory && entry.name.endsWith(".xml", ignoreCase = true)) {
                val basename = Path(entry.name).fileName.toString()
                Files.copy(zin, targetDir.resolve(basename), StandardCopyOption.REPLACE_EXISTING)
                count++
            }
            zin.closeEntry()
            entry = zin.nextEntry
        }
    }
    if (count == 0) throw IllegalStateException("Downloaded DDF zip contains no XML files")
    return count
}
```

### DDF state short-circuit

```kotlin
fun fetchPolicyDdfIfChanged() {
    val url = DdfUrlDiscoverer.discover(readOverviewMarkdown())
    val prior = DdfState.readOrNull()
    if (prior?.discoveredUrl == url && hasExtractedXml()) {
        DdfState.write(prior.copy(checkedAt = Instant.now().toString()))
        return
    }
    val (bytes, lastModified, etag) = httpDownload(url)
    val count = extractFlat(bytes, Paths.policyDdfExtractedDir)
    DdfState.write(
        DdfState(
            discoveredUrl = url,
            downloadedAt = Instant.now().toString(),
            checkedAt = Instant.now().toString(),
            sourceBytes = bytes.size,
            lastModified = lastModified,
            etag = etag,
            xmlCount = count,
        )
    )
}
```

### Packing both zips

Use `ZipOutputStream` with `STORED` or `DEFLATED` (default). Entries must be added in a deterministic order — sort files alphabetically — so bit-for-bit diffs between unchanged builds are possible (nice-to-have, not required).

## Porting gotchas

| Trap | Mitigation |
|------|-----------|
| JDK `HttpClient` by default does **not** follow HTTP → HTTPS redirects. | Set `HttpClient.Builder().followRedirects(Redirect.ALWAYS)`. |
| JDK `HttpClient` does **not** send `Accept-Encoding: identity` by default; it may negotiate gzip. | Set it explicitly to avoid having to decode. |
| Windows vs. Unix line endings. | Always write files in binary mode. Only the markdown bodies should retain upstream EOLs. |
| JSON pretty-printing. | Jackson's default `DefaultPrettyPrinter` outputs 2-space indent — matches Node output. Verify with golden files. |
| Zip entry timestamps. | `ZipEntry.setTime(0)` or a fixed date to make bit-for-bit reproducible. Not required, but helpful for debugging. |
| Regex anchor behavior. | The DDF discovery regex intentionally uses no `^`/`$` anchors. Do not add them. |
| Kotlin `Regex.find` returns first match by default — correct behavior. | N/A — call out so a reviewer doesn't "improve" it to `findAll().first()`. |
| JSON parsing: `toc.json` is large-ish (~100 KB) but fits easily in memory. | Use `readTree()`, not streaming — the algorithm is recursive. |
| Concurrency: do not parallelize TOC walk or zip pack. | Only the page fetch benefits from parallelism. |
| `UserAgent` header name is spelled as `User-Agent`. | HttpClient is case-insensitive on the wire, but use the canonical form. |
| Surrogate pairs in JSON. | Jackson handles correctly by default. Don't hand-roll string escaping. |

## Testing strategy

1. **Unit tests (fast, no network)**:
   - `SlugNormalizer` — table-driven tests of ~30 href variants → expected slug.
   - `PolicyFilter` — allowlist, prefix excludes, non-Policy CSPs with "Policy" in the name.
   - `TocWalker` — feed a saved TOC snapshot, assert count and absence of forbidden slugs.
   - `DdfUrlDiscoverer` — positive (current month, with surrounding whitespace) and negative (older-archive links) fixtures.
   - `Packer` — feed a directory of files, verify produced zip has expected entries + manifest.

2. **Integration tests (controlled network)**:
   - Spin up `MockWebServer` serving canned TOC + a handful of pages + a tiny fake zip. Drive the full pipeline. Assert zip outputs and state transitions.
   - Re-run the same pipeline with state preserved. Assert 304s and URL short-circuit.

3. **Smoke test against real Microsoft** (manual or CI nightly):
   - Run end-to-end against `learn.microsoft.com`. Assert ≥ 170 slugs, ≥ 300 XML files, both zips produced, no 4xx/5xx in `errors[]`.

4. **Golden file comparison (recommended)**:
   - Save last known-good `csp-docs.zip` as a fixture. Reimplementation builds a new zip from the same inputs. Compare **manifests** (allowing `generatedAt` to differ) and compare `pages/*.md` byte-for-byte. Divergence is a bug.

## Migration path (run alongside)

The safest port is "run both, diff outputs, flip":

1. Spin up the JVM scraper as a **separate** scheduled job that writes to a different GitHub repo / artifact name.
2. Let it run weekly for ~4 weeks.
3. Diff the outputs weekly — both manifests and `pages/*.md` + `extracted/*.xml`. Acceptable diffs:
   - `generatedAt`, `tocFetchedAt`, `checkedAt` — always differ
   - `counts.updated` vs `counts.notModified` split — depends on timing
   - `etag` field values — Microsoft may rotate these independently of content
4. Unacceptable diffs:
   - Any missing or extra slug
   - Any `pages/*.md` byte diff (after normalizing for line endings if needed)
   - Any missing or extra XML file in `extracted/`
5. Once a clean week passes, **redirect consumers** to the new URL. The old scraper can be retired after one more week of overlap.

## Operational checklist post-port

- [ ] Public repo with stable `latest` release URL
- [ ] Weekly cron + manual dispatch
- [ ] `actions/cache` or equivalent for state
- [ ] Prior-release restore for warm cache
- [ ] Build-time verification that `pages/policy-configuration-service-provider.md` exists
- [ ] Build-time verification that no `pages/policy-csp-*.md` leaked in
- [ ] Non-zero exit on any unrecovered page error
- [ ] Dashboard or log alert for three consecutive failed runs
