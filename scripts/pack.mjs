import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import {
  outputDir,
  distDir,
  slugsPath,
  manifestPath,
  zipPath,
  policyDdfDir,
  policyDdfExtractedDir,
  policyDdfStatePath,
  policyDdfZipPath,
} from './paths.mjs'

function packCspDocs() {
  const slugs = JSON.parse(fs.readFileSync(slugsPath, 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  const pagesOnDisk = fs
    .readdirSync(outputDir)
    .filter((f) => f.endsWith('.md'))
    .sort()

  const rootManifest = {
    artifact: 'csp-docs',
    generatedAt: manifest.generatedAt,
    source: manifest.source,
    tocFetchedAt: manifest.tocFetchedAt,
    counts: {
      ...manifest.counts,
      filesShipped: pagesOnDisk.length,
    },
    missing: manifest.missing,
    pages: pagesOnDisk,
  }

  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath)

  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(rootManifest, null, 2)))
  zip.addFile('slugs.json', Buffer.from(JSON.stringify(slugs, null, 2)))
  for (const file of pagesOnDisk) {
    const abs = path.join(outputDir, file)
    zip.addFile(`pages/${file}`, fs.readFileSync(abs))
  }
  zip.writeZip(zipPath)

  const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2)
  console.log(
    `[pack] wrote ${path.relative(process.cwd(), zipPath)} (${sizeMB} MB, ${pagesOnDisk.length} pages)`,
  )
}

function packPolicyDdf() {
  if (!fs.existsSync(policyDdfStatePath)) {
    console.warn('[pack] no policy-ddf state found — skipping policy-ddf.zip')
    return
  }
  const state = JSON.parse(fs.readFileSync(policyDdfStatePath, 'utf8'))
  if (!fs.existsSync(policyDdfExtractedDir)) {
    console.warn('[pack] no extracted XML dir — skipping policy-ddf.zip')
    return
  }
  const xmlFiles = fs
    .readdirSync(policyDdfExtractedDir)
    .filter((f) => f.endsWith('.xml'))
    .sort()
  if (xmlFiles.length === 0) {
    console.warn('[pack] no XML files to pack — skipping policy-ddf.zip')
    return
  }

  const manifest = {
    artifact: 'policy-ddf',
    generatedAt: new Date().toISOString(),
    source: state.discoveredUrl,
    upstreamLastModified: state.lastModified,
    upstreamEtag: state.etag,
    downloadedAt: state.downloadedAt,
    checkedAt: state.checkedAt,
    sourceBytes: state.sourceBytes,
    counts: {
      xmlFiles: xmlFiles.length,
    },
    files: xmlFiles,
  }

  if (fs.existsSync(policyDdfZipPath)) fs.unlinkSync(policyDdfZipPath)

  // Layout inside the zip intentionally mirrors cpt-csp-ui/backend/data/ddf/
  // so consumers can unzip straight to that dir and have everything in place.
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
  for (const file of xmlFiles) {
    zip.addFile(`extracted/${file}`, fs.readFileSync(path.join(policyDdfExtractedDir, file)))
  }
  zip.writeZip(policyDdfZipPath)

  const sizeMB = (fs.statSync(policyDdfZipPath).size / 1024 / 1024).toFixed(2)
  console.log(
    `[pack] wrote ${path.relative(process.cwd(), policyDdfZipPath)} (${sizeMB} MB, ${xmlFiles.length} XML files)`,
  )
}

try {
  fs.mkdirSync(distDir, { recursive: true })
  packCspDocs()
  packPolicyDdf()
} catch (err) {
  console.error(`[pack] ${err.stack || err.message}`)
  process.exit(1)
}
