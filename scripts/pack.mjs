import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import {
  outputDir,
  stateDir,
  distDir,
  slugsPath,
  manifestPath,
  zipPath,
} from './paths.mjs'

function main() {
  const slugs = JSON.parse(fs.readFileSync(slugsPath, 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  const pagesOnDisk = fs
    .readdirSync(outputDir)
    .filter((f) => f.endsWith('.md'))
    .sort()

  const rootManifest = {
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

  fs.mkdirSync(distDir, { recursive: true })
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

try {
  main()
} catch (err) {
  console.error(`[pack] ${err.stack || err.message}`)
  process.exit(1)
}
