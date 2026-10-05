// Drives the built app's search extras: title card, favorites, watch + first check, history.
//   npm run build && node scripts/e2e-library.mjs [query]

import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.SHOT_DIR ?? join(root, 'screenshots')
mkdirSync(shots, { recursive: true })
const query = process.argv[2] ?? 'the boys'
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
await page.waitForSelector('input[placeholder^="Search"]')
await page.waitForFunction(() => !document.querySelector('input[placeholder^="Search"]').placeholder.startsWith('Search 0 '))

await page.fill('input[placeholder^="Search"]', query)
await page.keyboard.press('Enter')
await page.waitForSelector('text=Results from', { timeout: 60_000 })
const card = await page.locator('h2').first().textContent().catch(() => null)
check(!!card, `title card shown: ${card}`)
await page.screenshot({ path: join(shots, 'library-search.png') })

// star the first result
await page.locator('button[title="Add to favorites"]').first().click({ force: true })
await page.waitForTimeout(300)
const favs = await page.evaluate(() => window.api.favorites())
check(favs.length === 1, `favorite stored: ${favs[0]?.release.title}`)

// watch with a filter
await page.click('button:has-text("1080p")')
await page.click('button:has-text("Watch")')
let watch
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000)
  ;[watch] = await page.evaluate(() => window.api.watches())
  if (watch?.checkedAt) break
}
check(!!watch?.checkedAt, `watch created and first check done (filters ${JSON.stringify(watch?.filters)})`)
check(watch?.newCount === 0, 'first check is baseline, nothing reported as new')
check(!!(await page.locator('text=Watching').count()), 'search toolbar shows "Watching"')

const history = await page.evaluate(() => window.api.history())
check(history[0]?.query === query && history[0].results > 0, `history has "${history[0]?.query}" with ${history[0]?.results} results`)

await page.click('nav >> text=Library')
await page.waitForTimeout(500)
await page.screenshot({ path: join(shots, 'library-watching.png') })
await page.click('button:has-text("Favorites")')
await page.waitForTimeout(300)
await page.screenshot({ path: join(shots, 'library-favorites.png') })
await app.close()
