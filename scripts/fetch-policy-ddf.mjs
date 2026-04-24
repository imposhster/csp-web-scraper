// Discovers the current Policy DDF zip URL by parsing the already-scraped
// configuration-service-provider-ddf.md, then downloads + extracts it into
// state/policy-ddf/extracted/. Skips both the download AND the re-extract when
// the discovered URL is unchanged since the prior run — the consumer is a
// downstream catalog builder that doesn't need to redo work for unchanged
// upstream content.

import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { request } from './http.mjs'
import {
  outputDir,
  policyDdfDir,
  policyDdfExtractedDir,
  policyDdfStatePath,
  configServiceProviderDdfSlug,
} from './paths.mjs'

const DDF_LINK_RE = /\[\s*DDF v2 Files[^\]]*\]\((https:\/\/download\.microsoft\.com\/[^)\s]+\.zip)\)/i

function discoverDdfUrl() {
  const mdPath = path.join(outputDir, `${configServiceProviderDdfSlug}.md`)
  if (!fs.existsSync(mdPath)) {
    throw new Error(
      `Cannot discover DDF URL: ${mdPath} missing. Run fetch-pages.mjs first.`,
    )
  }
  const md = fs.readFileSync(mdPath, 'utf8')
  const m = md.match(DDF_LINK_RE)
  if (!m) {
    throw new Error(
      `Failed to parse DDF zip URL from ${mdPath}. Microsoft may have changed the page format.`,
    )
  }
  return m[1]
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(policyDdfStatePath, 'utf8'))
  } catch {
    return null
  }
}

function hasExtractedXml() {
  if (!fs.existsSync(policyDdfExtractedDir)) return false
  return fs.readdirSync(policyDdfExtractedDir).some((f) => f.endsWith('.xml'))
}

async function download(url) {
  console.log(`[policy-ddf] downloading ${url}`)
  const res = await request(url)
  if (res.status !== 200) {
    throw new Error(`Policy DDF download failed: HTTP ${res.status} for ${url}`)
  }
  return {
    body: res.body,
    lastModified: res.headers['last-modified'] || null,
    etag: res.headers['etag'] || null,
  }
}

function extract(zipBuffer) {
  fs.rmSync(policyDdfExtractedDir, { recursive: true, force: true })
  fs.mkdirSync(policyDdfExtractedDir, { recursive: true })

  const zip = new AdmZip(zipBuffer)
  const entries = zip.getEntries()
  let xmlCount = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    // Flatten into extracted/: Microsoft's zips have varied internal structures
    // over the years. Only XML files are useful downstream.
    if (!entry.entryName.toLowerCase().endsWith('.xml')) continue
    const basename = path.basename(entry.entryName)
    fs.writeFileSync(path.join(policyDdfExtractedDir, basename), entry.getData())
    xmlCount++
  }
  if (xmlCount === 0) {
    throw new Error(`Downloaded DDF zip contains no XML files.`)
  }
  return xmlCount
}

async function main() {
  fs.mkdirSync(policyDdfDir, { recursive: true })

  const url = discoverDdfUrl()
  const prior = loadState()
  const priorUrl = prior?.discoveredUrl

  if (priorUrl === url && hasExtractedXml()) {
    console.log(
      `[policy-ddf] unchanged — URL ${url} matches prior run and extracted XML present; skipping.`,
    )
    // Touch state with a fresh checkedAt so manifests reflect this run's check.
    const next = {
      ...prior,
      checkedAt: new Date().toISOString(),
    }
    fs.writeFileSync(policyDdfStatePath, JSON.stringify(next, null, 2))
    return
  }

  if (priorUrl && priorUrl !== url) {
    console.log(`[policy-ddf] URL changed: ${priorUrl} -> ${url}`)
  } else if (!priorUrl) {
    console.log(`[policy-ddf] first run — no prior state`)
  } else {
    console.log(`[policy-ddf] extracted dir empty — re-downloading`)
  }

  const { body, lastModified, etag } = await download(url)
  const xmlCount = extract(body)

  const nextState = {
    discoveredUrl: url,
    downloadedAt: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
    sourceBytes: body.length,
    lastModified,
    etag,
    xmlCount,
  }
  fs.writeFileSync(policyDdfStatePath, JSON.stringify(nextState, null, 2))

  console.log(
    `[policy-ddf] extracted ${xmlCount} XML files (${(body.length / 1024 / 1024).toFixed(2)} MB source)`,
  )
}

main().catch((err) => {
  console.error(`[policy-ddf] ${err.stack || err.message}`)
  process.exit(1)
})
