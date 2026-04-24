import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipFetch } from './paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function run(script) {
  const result = spawnSync(process.execPath, [path.join(here, script)], {
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

if (!skipFetch) {
  run('fetch-toc.mjs')
  run('fetch-pages.mjs')
  run('fetch-policy-ddf.mjs')
} else {
  console.log('[build] CSP_SKIP_FETCH=1 — skipping fetch steps, packing existing output/')
}
run('pack.mjs')
