// Drop-in script for cpt-csp-ui/backend/scripts/fetch-policy-ddf.mjs
//
// Replaces download-ddf.mjs + extract-ddf.mjs. Downloads policy-ddf.zip from
// the csp-web-scraper "latest" release and extracts straight into
// backend/data/ddf/, producing data/ddf/extracted/*.xml and data/ddf/manifest.json.
//
// Migration in cpt-csp-ui/backend/:
//   1) Copy this file to backend/scripts/fetch-policy-ddf.mjs.
//   2) Delete scripts/download-ddf.mjs and scripts/extract-ddf.mjs (ddfPaths.mjs
//      can stay if build-catalog.mjs still imports it — just keep extractedDir).
//   3) In package.json, replace:
//        "fetch:ddf": "node scripts/download-ddf.mjs",
//        "extract:ddf": "node scripts/extract-ddf.mjs",
//      with:
//        "fetch:policy-ddf": "node scripts/fetch-policy-ddf.mjs",
//      and update prepare:catalog:
//        "prepare:catalog": "npm run fetch:policy-ddf && npm run fetch:csp-docs && npm run build:catalog"

import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import unzipper from 'unzipper'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_URL =
  'https://github.com/imposhster/csp-web-scraper/releases/latest/download/policy-ddf.zip'
const url = process.env.POLICY_DDF_URL || DEFAULT_URL

const ddfDir = path.resolve(__dirname, '../data/ddf')
const extractedDir = path.join(ddfDir, 'extracted')
const zipPath = path.join(ddfDir, 'policy-ddf.zip')
const manifestPath = path.join(ddfDir, 'manifest.json')

fs.mkdirSync(ddfDir, { recursive: true })

if (process.env.POLICY_DDF_SKIP_DOWNLOAD === '1' && fs.existsSync(manifestPath)) {
  console.log('Skipping Policy DDF download: manifest already present (POLICY_DDF_SKIP_DOWNLOAD=1).')
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
              `Failed to download Policy DDF zip (${response.statusCode}) from ${fileUrl}.\n` +
                `Override with POLICY_DDF_URL if the upstream location changes.`,
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
console.log(`Downloaded Policy DDF zip to ${zipPath}`)

// Extract fresh so removed XMLs don't linger.
fs.rmSync(extractedDir, { recursive: true, force: true })
if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath)

await fs
  .createReadStream(zipPath)
  .pipe(unzipper.Extract({ path: ddfDir }))
  .promise()

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
console.log(
  `Extracted ${manifest.counts.xmlFiles} Policy DDF XML files (source ${manifest.source})`,
)
