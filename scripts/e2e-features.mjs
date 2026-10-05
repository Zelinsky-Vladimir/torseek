// Language setup + tracker check, relevance / audio filters, "where to save?" and a
// magnet with dead trackers, in the built app.
//   npm run build && node scripts/e2e-features.mjs

import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.SHOT_DIR ?? join(root, 'screenshots')
mkdirSync(shots, { recursive: true })
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) })

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  args: [root],
  env: { ...process.env, TORSEEK_USER_DATA: mkdtempSync(join(tmpdir(), 'torseek-e2e-')), TORSEEK_NO_UPDATE: '1', TORSEEK_LANG: process.env.TORSEEK_LANG ?? 'ru' },
})
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('[renderer:exception]', e.message))

// 1. First launch asks for search languages
await page.waitForSelector('text=Продолжить', { timeout: 20_000 })
await shot(page, 'feat-1-languages')
await page.click('text=Продолжить')
const t0 = Date.now()
let status
do {
  await page.waitForTimeout(3000)
  status = await page.evaluate(() => window.api.trackerCheckStatus())
} while (status.running && Date.now() - t0 < 240_000)
const list = await page.evaluate(() => window.api.listIndexers())
const on = list.filter((i) => i.enabled)
console.log(`tracker check: ${status.done}/${status.total} in ${Math.round((Date.now() - t0) / 1000)}s; enabled ${on.length}:`, on.map((i) => `${i.name}(${(i.language ?? '').slice(0, 2)})`).join(', '))

// 2. Search: loose matches hidden, audio filter
await page.click('nav button >> nth=0')
await page.locator('input').first().fill('dune')
await page.keyboard.press('Enter')
await page.waitForFunction(() => document.body.innerText.includes('Результаты с'), null, { timeout: 60_000 })
await page.waitForTimeout(20_000)
const loose = await page.locator('button:has-text("неточн")').first().innerText().catch(() => '(no loose button)')
console.log('loose:', loose)
await shot(page, 'feat-2-search')
await page.selectOption('select:near(:text("Озвучка"))', 'en')
await page.waitForTimeout(800)
await shot(page, 'feat-3-audio-en')
const count = await page.evaluate(() => document.body.innerText.match(/\d+ результат\S*( из \d+)?/)?.[0])
console.log('with English audio:', count)
await page.selectOption('select:near(:text("Субтитры"))', 'en')
await page.waitForTimeout(800)
await shot(page, 'feat-3b-subs-en')
console.log('with English audio + subtitles:', await page.evaluate(() => document.body.innerText.match(/\d+ результат\S*( из \d+)?/)?.[0]))
await page.selectOption('select:near(:text("Субтитры"))', '')

// 3. Download asks where to save
await page.locator('button[title="Скачать"]').first().click()
await page.waitForSelector('text=Куда сохранить?', { timeout: 10_000 })
await shot(page, 'feat-4-save')
await page.click('text=Отмена')

// 4. Magnet with only dead trackers gets metadata thanks to the added tracker list
const dead = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fretracker.hotplug.ru%3A2710%2Fannounce'
const { infoHash } = await page.evaluate((m) => window.api.addMagnet(m), dead)
let files = []
for (let i = 0; i < 60 && !files.length; i++) {
  await page.waitForTimeout(1000)
  files = await page.evaluate((h) => window.api.torrentFiles(h), infoHash)
}
console.log(`dead-tracker magnet: ${files.length ? `metadata in ~${files.length && 'under 60'}s, ${files.length} files` : 'NO METADATA after 60s'}`)
await page.evaluate((h) => window.api.removeTorrent(h, true), infoHash)
const t1 = Date.now()
await app.close()
console.log(`closed in ${((Date.now() - t1) / 1000).toFixed(1)}s`)
