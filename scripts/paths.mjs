import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const rootDir = path.resolve(here, '..')

export const outputDir = path.join(rootDir, 'output')
export const stateDir = path.join(rootDir, 'state')
export const distDir = path.join(rootDir, 'dist')

export const slugsPath = path.join(stateDir, 'slugs.json')
export const manifestPath = path.join(stateDir, 'manifest.json')
export const zipPath = path.join(distDir, 'csp-docs.zip')

export const policyDdfDir = path.join(stateDir, 'policy-ddf')
export const policyDdfExtractedDir = path.join(policyDdfDir, 'extracted')
export const policyDdfStatePath = path.join(policyDdfDir, 'state.json')
export const policyDdfZipPath = path.join(distDir, 'policy-ddf.zip')

export const configServiceProviderDdfSlug = 'configuration-service-provider-ddf'

export const mdmBaseUrl =
  process.env.CSP_MDM_BASE_URL ||
  'https://learn.microsoft.com/en-us/windows/client-management/mdm'

export const tocUrl =
  process.env.CSP_TOC_URL || `${mdmBaseUrl}/toc.json`

export const markdownUrlFor = (slug) =>
  `${mdmBaseUrl}/${slug}?accept=text/markdown`

export const maxConcurrency = Number(process.env.CSP_MAX_CONCURRENCY) || 8
export const forceRefresh = process.env.CSP_FORCE_REFRESH === '1'
export const skipFetch = process.env.CSP_SKIP_FETCH === '1'
