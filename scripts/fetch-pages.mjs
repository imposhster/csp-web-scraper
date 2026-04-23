import fs from 'node:fs'
import path from 'node:path'
import { request } from './http.mjs'
import {
  outputDir,
  stateDir,
  slugsPath,
  manifestPath,
  markdownUrlFor,
  maxConcurrency,
  forceRefresh,
} from './paths.mjs'

const MAX_RETRIES = 3

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function fetchOne(slug, priorEntry) {
  const url = markdownUrlFor(slug)
  const headers = {}
  if (!forceRefresh && priorEntry?.lastModified) {
    headers['If-Modified-Since'] = priorEntry.lastModified
  }
  if (!forceRefresh && priorEntry?.etag) {
    headers['If-None-Match'] = priorEntry.etag
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await request(url, { headers })
    const status = res.status
    if (status === 200) {
      return {
        outcome: 'updated',
        body: res.body,
        lastModified: res.headers['last-modified'] || null,
        etag: res.headers['etag'] || null,
        bytes: res.body.length,
      }
    }
    if (status === 304) {
      return { outcome: 'not-modified' }
    }
    if (status === 404) {
      return { outcome: 'missing' }
    }
    if (status === 429 || (status >= 500 && status < 600)) {
      const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1))
      console.warn(`[pages] ${slug}: HTTP ${status}, retrying in ${wait}ms (attempt ${attempt}/${MAX_RETRIES})`)
      await sleep(wait)
      continue
    }
    return { outcome: 'error', status }
  }
  return { outcome: 'error', status: 'retries exhausted' }
}

async function runPool(items, workerCount, worker) {
  const iter = items[Symbol.iterator]()
  const runners = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const next = iter.next()
      if (next.done) return
      await worker(next.value)
    }
  })
  await Promise.all(runners)
}

async function main() {
  const slugsPayload = loadJSON(slugsPath, null)
  if (!slugsPayload || !Array.isArray(slugsPayload.slugs)) {
    throw new Error(`missing ${slugsPath} — run fetch:toc first`)
  }
  const slugs = slugsPayload.slugs

  fs.mkdirSync(outputDir, { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })

  const prior = loadJSON(manifestPath, { pages: {}, missing: [] })
  const priorPages = prior.pages || {}

  const pages = {}
  const missing = []
  const errors = []
  let updated = 0
  let notModified = 0
  let startedAt = Date.now()

  await runPool(slugs, maxConcurrency, async (slug) => {
    const priorEntry = priorPages[slug]
    const outPath = path.join(outputDir, `${slug}.md`)
    try {
      const result = await fetchOne(slug, priorEntry)
      if (result.outcome === 'updated') {
        fs.writeFileSync(outPath, result.body)
        pages[slug] = {
          lastModified: result.lastModified,
          etag: result.etag,
          bytes: result.bytes,
        }
        updated++
        process.stdout.write('.')
      } else if (result.outcome === 'not-modified') {
        // Preserve prior metadata; file should already exist on disk.
        if (priorEntry) pages[slug] = priorEntry
        if (!fs.existsSync(outPath)) {
          // Cache said 304 but we don't have the file locally — force-refetch once.
          const again = await fetchOne(slug, null)
          if (again.outcome === 'updated') {
            fs.writeFileSync(outPath, again.body)
            pages[slug] = {
              lastModified: again.lastModified,
              etag: again.etag,
              bytes: again.bytes,
            }
            updated++
          } else if (again.outcome === 'missing') {
            missing.push(slug)
          } else {
            errors.push({ slug, outcome: again.outcome, status: again.status })
          }
        } else {
          notModified++
        }
        process.stdout.write('=')
      } else if (result.outcome === 'missing') {
        missing.push(slug)
        // Remove stale file if present so the zip doesn't ship removed pages.
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
        process.stdout.write('x')
      } else {
        errors.push({ slug, status: result.status })
        process.stdout.write('!')
      }
    } catch (err) {
      errors.push({ slug, message: err.message })
      process.stdout.write('!')
    }
  })

  process.stdout.write('\n')

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: slugsPayload.source,
    tocFetchedAt: slugsPayload.fetchedAt,
    durationMs: Date.now() - startedAt,
    counts: {
      total: slugs.length,
      updated,
      notModified,
      missing: missing.length,
      errors: errors.length,
    },
    pages,
    missing: missing.sort(),
    errors,
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  console.log(
    `[pages] ${slugs.length} slugs | ${updated} updated | ${notModified} unchanged | ${missing.length} missing | ${errors.length} errors (${manifest.durationMs} ms)`,
  )
  if (missing.length) console.log(`[pages] missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`)
  if (errors.length) {
    console.error(`[pages] errors:`)
    for (const e of errors) console.error(`  ${JSON.stringify(e)}`)
    process.exit(2)
  }
}

main().catch((err) => {
  console.error(`[pages] ${err.stack || err.message}`)
  process.exit(1)
})
