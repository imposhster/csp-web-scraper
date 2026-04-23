import fs from 'node:fs'
import path from 'node:path'
import { requestText } from './http.mjs'
import { tocUrl, slugsPath, stateDir } from './paths.mjs'

const POLICY_SLUG = 'policy-configuration-service-provider'

function isExcluded(href) {
  if (href.startsWith('policy-')) return true
  if (href === POLICY_SLUG) return true
  return false
}

function normalize(href) {
  // toc.json hrefs can be "./foo", "foo", "foo.md", or absolute. We want bare slugs.
  let h = href.trim()
  if (!h) return null
  // Reject anything that isn't a relative slug in this directory.
  if (/^https?:/i.test(h)) return null
  if (h.startsWith('#')) return null
  // Strip leading "./" and a trailing extension, fragment, or query.
  h = h.replace(/^\.\//, '')
  // Reject hrefs that navigate out of the mdm/ folder.
  if (h.startsWith('../') || h.startsWith('/')) return null
  h = h.split('#')[0].split('?')[0]
  h = h.replace(/\.md$/i, '')
  if (!h) return null
  // Slug sanity: alphanumerics, hyphens, underscores only.
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(h)) return null
  return h
}

function collect(node, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return
  }
  const href = typeof node.href === 'string' ? node.href : null
  if (href) {
    const slug = normalize(href)
    if (slug && !isExcluded(slug)) out.add(slug)
  }
  // TOC files use different container keys depending on level.
  for (const key of ['items', 'children', 'toc']) {
    if (node[key]) collect(node[key], out)
  }
}

async function main() {
  console.log(`[toc] fetching ${tocUrl}`)
  const res = await requestText(tocUrl)
  if (res.status !== 200) {
    throw new Error(`TOC fetch failed: HTTP ${res.status}`)
  }
  let toc
  try {
    toc = JSON.parse(res.text)
  } catch (err) {
    throw new Error(`TOC JSON parse failed: ${err.message}`)
  }

  const slugs = new Set()
  collect(toc, slugs)
  const sorted = [...slugs].sort()

  fs.mkdirSync(stateDir, { recursive: true })
  const payload = {
    fetchedAt: new Date().toISOString(),
    source: tocUrl,
    count: sorted.length,
    slugs: sorted,
  }
  fs.writeFileSync(slugsPath, JSON.stringify(payload, null, 2))

  const policyKept = sorted.filter((s) => s.startsWith('policy-'))
  console.log(`[toc] kept ${sorted.length} slugs; wrote ${path.relative(process.cwd(), slugsPath)}`)
  if (policyKept.length) {
    throw new Error(`Filter bug: ${policyKept.length} policy- slugs leaked through`)
  }
}

main().catch((err) => {
  console.error(`[toc] ${err.message}`)
  process.exit(1)
})
