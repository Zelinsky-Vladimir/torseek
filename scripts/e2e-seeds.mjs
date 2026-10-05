// Live seed counts from the trackers vs the numbers the sites show, in the built app.
//   npm run build && node scripts/e2e-seeds.mjs [query]

import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const query = process.argv[2] ?? 'dune'
const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  args: [root],
  env: { ...process.env, TORSEEK_USER_DATA: mkdtempSync(join(tmpdir(), 'torseek-e2e-')), TORSEEK_NO_UPDATE: '1', TORSEEK_LANG: 'en' },
})
const page = await app.firstWindow()
await page.waitForSelector('nav button')
await page.waitForTimeout(1500)

const out = await page.evaluate(
  (q) =>
    new Promise((resolve) => {
      const searchId = `e2e-${Math.random()}`
      const started = Date.now()
      const releases = []
      const stats = {}
      let doneAt = 0
      const off = window.api.onSearchEvent((e) => {
        if (e.searchId !== searchId) return
        if (e.type === 'results') releases.push(...e.releases)
        if (e.type === 'seeds') Object.assign(stats, e.stats)
        if (e.type === 'done') doneAt = Date.now() - started
      })
      void window.api.search({ searchId, q })
      // seeds may arrive a little after "done"
      const wait = setInterval(() => {
        if (doneAt && Date.now() - started > doneAt + 5000) {
          clearInterval(wait)
          off()
          resolve({ releases, stats, doneAt })
        }
      }, 500)
    }),
  query,
)
const hashOf = (r) => (r.infoHash ?? /btih:([a-z0-9]+)/i.exec(r.magnet ?? '')?.[1] ?? '').toLowerCase()
const withHash = out.releases.filter((r) => /^[0-9a-f]{40}$/.test(hashOf(r)))
// Same rule as withLiveSeeds: torrents that only name the site's own tracker keep the site's count
const trs = (r) => (r.magnet ?? '').split('&').filter((p) => p.startsWith('tr=')).map((p) => decodeURIComponent(p.slice(3)))
const open = (r) => trs(r).length === 0 || trs(r).some((t) => /opentrackr|demonii|stealth|torrent.eu.org|desync|explodie|qu.ax|opentracker|openbittorrent|theoks|srv00/i.test(t))
const live = withHash.filter((r) => out.stats[hashOf(r)] && open(r))
console.log(`kept the site's count (own tracker): ${withHash.filter((r) => !open(r)).length}`)
console.log(`${out.releases.length} results in ${(out.doneAt / 1000).toFixed(1)}s, ${withHash.length} with a hex hash, live counts for ${live.length}`)
const diffs = live
  .map((r) => ({ title: r.title.slice(0, 60), site: r.seeders ?? 0, real: out.stats[hashOf(r)].seeders, tracker: r.indexerName }))
  .sort((a, b) => b.site - b.real - (a.site - a.real))
console.log('biggest overstatements (site -> real):')
for (const d of diffs.slice(0, 8)) console.log(`  ${d.site} -> ${d.real}  ${d.tracker}: ${d.title}`)
const dead = diffs.filter((d) => d.site >= 10 && d.real === 0).length
console.log(`listed with 10+ seeds on the site but 0 on the trackers: ${dead}`)
await app.close()
