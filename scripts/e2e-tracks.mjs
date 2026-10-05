// Track check on a legal torrent (Sintel: MP4 + .srt files, has a web seed), in the built app.
//   npm run build && node scripts/e2e-tracks.mjs

import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SINTEL =
  'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=wss%3A%2F%2Ftracker.webtorrent.dev&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  args: [root],
  env: { ...process.env, TORSEEK_USER_DATA: mkdtempSync(join(tmpdir(), 'torseek-e2e-')), TORSEEK_NO_UPDATE: '1', TORSEEK_DOWNLOAD_DIR: mkdtempSync(join(tmpdir(), 'torseek-dl-')), TORSEEK_LANG: 'en' },
})
const page = await app.firstWindow()
await page.waitForSelector('nav button')
const release = { indexerId: 'knaben', indexerName: 'Test', title: 'Sintel', guid: 'sintel', magnet: SINTEL, categories: [2000] }
const started = Date.now()
const tracks = await page.evaluate((r) => window.api.probeTracks(r), release)
console.log(`probe in ${Math.round((Date.now() - started) / 1000)}s: ${tracks.file} (${tracks.container})`)
for (const t of tracks.tracks) console.log(`  ${t.kind} ${t.lang}${t.name ? ` "${t.name}"` : ''}${t.external ? ' [file]' : ''}`)
const list = await page.evaluate(() => window.api.listTorrents())
console.log('torrents in the list after probing:', list.length)
await app.close()
