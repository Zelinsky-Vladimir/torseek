// Drives the built app's torrent client with a legal test torrent (Big Buck Bunny, has a
// web seed so it works without peers): file selection, streaming, player, close-to-tray.
//   npm run build && node scripts/e2e-client.mjs

import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BBB =
  'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.webtorrent.dev&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.SHOT_DIR ?? join(root, 'screenshots')
mkdirSync(shots, { recursive: true })
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) process.exitCode = 1
}

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  args: [root],
  env: { ...process.env, TORSEEK_USER_DATA: mkdtempSync(join(tmpdir(), 'torseek-e2e-')), TORSEEK_NO_UPDATE: '1', TORSEEK_LANG: 'en' },
})
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('[renderer:exception]', e.message))
await page.waitForSelector('nav button')

const { infoHash } = await page.evaluate((m) => window.api.addMagnet(m), BBB)
let files = []
for (let i = 0; i < 60 && !files.length; i++) {
  await page.waitForTimeout(1000)
  files = await page.evaluate((h) => window.api.torrentFiles(h), infoHash)
}
check(files.length > 1, `metadata loaded: ${files.map((f) => f.name).join(', ')}`)
const video = files.find((f) => f.name.endsWith('.mp4'))
check(!!video?.playable, 'mp4 marked playable')

await page.evaluate(([h, i]) => window.api.setFileSelection(h, [i]), [infoHash, video.index])
await page.waitForTimeout(1500)
const snap = (await page.evaluate(() => window.api.listTorrents())).find((t) => t.infoHash === infoHash)
check(snap.partial === true && Math.abs(snap.length - video.length) < 1, `partial download covers only the mp4 (${snap.length} bytes)`)
const after = await page.evaluate((h) => window.api.torrentFiles(h), infoHash)
check(after.filter((f) => f.selected).length === 1, 'only one file selected')

const url = await page.evaluate(([h, i]) => window.api.streamUrl(h, i), [infoHash, video.index])
const res = await fetch(url, { headers: { Range: 'bytes=0-65535' } })
const body = new Uint8Array(await res.arrayBuffer())
check(res.status === 206 && body.length === 65536, `stream serves byte ranges (${res.status}, ${body.length} bytes, ${res.headers.get('content-type')})`)
const ftyp = new TextDecoder().decode(body.slice(4, 8))
check(ftyp === 'ftyp', `stream starts with an MP4 header ("${ftyp}")`)

// UI: expand the torrent, open the player
await page.click('nav >> text=Downloads')
await page.click('button[title="Files"]')
await page.waitForSelector('text=Big Buck Bunny.mp4')
await page.screenshot({ path: join(shots, 'client-files.png') })
await page.click('button[title="Play"]')
await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 30_000 }).catch(() => {})
const ready = await page.evaluate(() => document.querySelector('video')?.readyState ?? -1)
check(ready >= 2, `in-app player has decoded frames (readyState ${ready})`)
await page.waitForTimeout(1500)
await page.screenshot({ path: join(shots, 'client-player.png') })
await page.keyboard.press('Escape')

// Close the window: the app should keep running in the tray
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
await page.waitForTimeout(800)
const state = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible() })))
check(state.length === 1 && !state[0].visible, 'closing the window hides it to the tray')

await page.evaluate((h) => window.api.removeTorrent(h, true), infoHash)
await app.close()
