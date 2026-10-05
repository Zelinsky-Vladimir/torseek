// Run the search engine from a terminal, without Electron. Handy for fixing definitions.
//
//   npm run search -- "ubuntu"                      # all supported public trackers
//   npm run search -- "ubuntu" --only 1337x,eztv    # specific trackers
//   npm run search -- "ubuntu" --json               # machine-readable per-tracker summary

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CardigannIndexer } from '../src/core/cardigann/indexer'
import { loadDefinitions } from '../src/core/cardigann/loader'
import { HttpClient } from '../src/core/http'
import { searchAll, type IndexerStatus } from '../src/core/search'
import type { Release } from '../src/core/release'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const query = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--only')) ?? ''
const only = flag('--only')?.split(',')
const asJson = args.includes('--json')
const debug = args.includes('--debug')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const defs = await loadDefinitions([join(root, 'definitions')])
const http = new HttpClient({ cookieJar: true })

const indexers = defs
  .filter((d) => !d.unsupported && (!only || only.includes(d.definition.id)))
  .map(
    (d) =>
      new CardigannIndexer(d.definition, {
        http,
        log: debug ? (level, msg) => console.error(`[${level}] ${msg}`) : undefined,
      }),
  )

const results = new Map<string, Release[]>()
const statuses = new Map<string, IndexerStatus>()
const started = Date.now()

await searchAll(indexers, { q: query }, {
  onResults: (id, r) => results.set(id, r),
  onStatus: (s) => {
    statuses.set(s.indexerId, s)
    if (!asJson && ['done', 'error', 'blocked', 'timeout'].includes(s.state)) {
      const tag = s.state === 'done' ? `${String(s.count).padStart(4)} results` : s.state.toUpperCase().padEnd(12)
      console.log(`${tag}  ${s.indexerId.padEnd(24)} ${String(s.elapsedMs).padStart(6)}ms  ${s.error ?? ''}`)
    }
  },
})

if (args.includes('--resolve')) {
  // Resolve the first result of every tracker to a magnet / .torrent, like the Download button
  console.log('\nResolving downloads:')
  await Promise.all(
    indexers.map(async (ix) => {
      const first = results.get(ix.id)?.[0]
      if (!first) return
      try {
        const t = await ix.resolveDownload(first)
        const what = t.kind === 'magnet' ? `magnet ${t.uri.slice(0, 60)}…` : `torrent ${t.data.length} bytes`
        console.log(`  OK    ${ix.id.padEnd(24)} ${what}`)
      } catch (e) {
        console.log(`  FAIL  ${ix.id.padEnd(24)} ${(e as Error).message}`)
      }
    }),
  )
}

if (asJson) {
  console.log(JSON.stringify([...statuses.values()].map(({ indexerId, state, count, error }) => ({ indexerId, state, count, error }))))
} else {
  const all = [...results.values()].flat().sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))
  const ok = [...statuses.values()].filter((s) => s.state === 'done' && (s.count ?? 0) > 0).length
  console.log(`\n${all.length} results from ${ok}/${indexers.length} trackers in ${Date.now() - started}ms\n`)
  for (const r of all.slice(0, 15)) {
    const size = r.size ? `${(r.size / 1024 ** 3).toFixed(2)} GB` : '?'
    console.log(`${String(r.seeders ?? '?').padStart(6)} S  ${size.padStart(9)}  ${r.publishDate?.slice(0, 10) ?? '          '}  [${r.indexerId}] ${r.title}`)
  }
}
