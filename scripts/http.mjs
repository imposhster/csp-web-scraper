import https from 'node:https'
import http from 'node:http'
import { URL } from 'node:url'

const USER_AGENT = 'csp-web-scraper (+https://github.com/)'

export function request(url, { headers = {}, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const visit = (currentUrl, redirectsLeft) => {
      const u = new URL(currentUrl)
      const mod = u.protocol === 'http:' ? http : https
      const req = mod.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            'Accept-Encoding': 'identity',
            ...headers,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0

          if (status >= 300 && status < 400 && res.headers.location) {
            if (redirectsLeft <= 0) {
              res.resume()
              return reject(new Error(`Too many redirects fetching ${url}`))
            }
            const next = new URL(res.headers.location, currentUrl).toString()
            res.resume()
            return visit(next, redirectsLeft - 1)
          }

          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({
              status,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          )
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      req.end()
    }
    visit(url, maxRedirects)
  })
}

export async function requestText(url, opts) {
  const res = await request(url, opts)
  return { ...res, text: res.body.toString('utf8') }
}
