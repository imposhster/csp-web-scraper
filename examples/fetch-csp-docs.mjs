// Drop-in script for cpt-csp-ui/backend/scripts/fetch-csp-docs.mjs
//
// Downloads csp-docs.zip from the csp-web-scraper "latest" release and extracts
// it into backend/data/csp-docs/. Mirrors the style of download-ddf.mjs.
//
// After install:
//   1) Copy this file to backend/scripts/fetch-csp-docs.mjs
//   2) In backend/package.json, add:
//        "fetch:csp-docs": "node scripts/fetch-csp-docs.mjs"
//      and chain it into prepare:catalog, e.g.
//        "prepare:catalog": "npm run fetch:ddf && npm run extract:ddf && npm run fetch:csp-docs && npm run build:catalog"
//   3) Consumers read pages from backend/data/csp-docs/pages/*.md and metadata
//      from backend/data/csp-docs/manifest.json.

import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import unzipper from 'unzipper'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_URL =
  'https://github.com/imposhster/csp-web-scraper/releases/latest/download/csp-docs.zip'
const url = process.env.CSP_DOCS_URL || DEFAULT_URL

const cspDocsDir = path.resolve(__dirname, '../data/csp-docs')
const zipPath = path.join(cspDocsDir, 'csp-docs.zip')
const pagesDir = path.join(cspDocsDir, 'pages')
const manifestPath = path.join(cspDocsDir, 'manifest.json')

fs.mkdirSync(cspDocsDir, { recursive: true })

if (process.env.CSP_DOCS_SKIP_DOWNLOAD === '1' && fs.existsSync(manifestPath)) {
  console.log('Skipping CSP docs download: manifest already present (CSP_DOCS_SKIP_DOWNLOAD=1).')
  process.exit(0)
}

function download(fileUrl, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)

    https
      .get(fileUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close()
          fs.unlinkSync(dest)
          return resolve(download(response.headers.location, dest))
        }

        if (response.statusCode !== 200) {
          file.close()
          fs.unlinkSync(dest)
          return reject(
            new Error(
              `Failed to download CSP docs zip (${response.statusCode}) from ${fileUrl}.\n` +
                `Override with CSP_DOCS_URL if the upstream location changes.`,
            ),
          )
        }

        response.pipe(file)
        file.on('finish', () => {
          file.close()
          resolve()
        })
      })
      .on('error', (err) => {
        file.close()
        if (fs.existsSync(dest)) fs.unlinkSync(dest)
        reject(err)
      })
  })
}

await download(url, zipPath)
console.log(`Downloaded CSP docs zip to ${zipPath}`)

// Extract fresh: the zip fully represents the latest state.
fs.rmSync(pagesDir, { recursive: true, force: true })
if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath)
const slugsPath = path.join(cspDocsDir, 'slugs.json')
if (fs.existsSync(slugsPath)) fs.unlinkSync(slugsPath)

await fs
  .createReadStream(zipPath)
  .pipe(unzipper.Extract({ path: cspDocsDir }))
  .promise()

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
console.log(
  `Extracted CSP docs: ${manifest.counts.filesShipped} pages, built ${manifest.generatedAt}`,
)
