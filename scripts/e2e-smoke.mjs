// End-to-end smoke run of the built app: search -> download -> downloads list.
//   npm run build && node scripts/e2e-smoke.mjs [query] [--keep]
// Uses a throwaway profile (TORSEEK_USER_DATA) and writes screenshots to SHOT_DIR.

import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.SHOT_DIR ?? join(root, 'screenshots')
mkdirSync(shots, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'torseek-e2e-'))
const query = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'ubuntu 26.04'
const keep = process.argv.includes('--keep')

const electronBin = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
// TORSEEK_EXE=dist/win-unpacked/Torseek.exe runs the packaged app instead of the dev build
const exe = process.env.TORSEEK_EXE
const app = await electron.launch({
  executablePath: exe ?? electronBin,
  args: exe ? [] : [root],
  env: { ...process.env, TORSEEK_USER_DATA: userData, TORSEEK_NO_UPDATE: '1', TORSEEK_LANG: process.env.TORSEEK_LANG ?? 'en' },
  timeout: 30_000,
})
app.process().stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`))
app.process().stderr?.on('data', (d) => process.stdout.write(`[main:err] ${d}`))

const page = await app.firstWindow()
page.on('console', (m) => m.type() === 'error' && console.log('[renderer:error]', m.text()))
page.on('pageerror', (e) => console.log('[renderer:exception]', e.message))
await page.setViewportSize?.({ width: 1320, height: 860 }).catch(() => {})
const shot = async (name) => {
  await page.screenshot({ path: join(shots, `${name}.png`) })
  console.log('screenshot', name)
}

await page.waitForSelector('input[placeholder^="Search"]')
// Skip first-run questions: search languages, and "where to save?" on every download
await page.evaluate(() => window.api.updateSettings({ searchLanguages: ['en', 'ru'], askWhereToSave: false }))
await page.reload()
await page.waitForSelector('input[placeholder^="Search"]')
await page.waitForFunction(() => !document.querySelector('input[placeholder^="Search"]').placeholder.startsWith('Search 0 '))
await shot('01-welcome')

await page.fill('input[placeholder^="Search"]', query)
await page.keyboard.press('Enter')
await page.waitForSelector('text=Searching', { timeout: 10_000 })
await page.waitForTimeout(1500)
await shot('02-searching')
await page.waitForSelector('text=Results from', { timeout: 60_000 })
const summary = await page.locator('text=Results from').first().innerText()
const count = await page.locator('button[title="Download"]').count()
console.log(`search done: ${summary.replace(/\s+/g, ' ')} | ${count} rows rendered`)
await shot('03-results')

// expand per-tracker status
await page.click('text=Results from')
await shot('04-tracker-status')

// download the best-seeded result
const firstTitle = await page.locator('button[title="Download"]').first().locator('xpath=ancestor::div[contains(@class,"grid")][1]').locator('div.truncate').first().innerText()
console.log('downloading:', firstTitle)
await page.locator('button[title="Download"]').first().click()
const toast = await page.waitForSelector('text=/Added|:/', { timeout: 45_000 })
console.log('toast:', (await toast.innerText()).replace(/\s+/g, ' '))
await shot('05-added')

await page.click('nav >> text=Downloads')
await page.waitForTimeout(12_000)
const row = await page.locator('main').innerText()
console.log('downloads page:\n' + row.split('\n').slice(0, 14).join('\n'))
await shot('06-downloads')

await page.click('nav >> text=Trackers')
await page.waitForTimeout(500)
await shot('07-trackers')
await page.click('nav >> text=Settings')
await page.waitForTimeout(300)
await shot('08-settings')

if (!keep) {
  // clean up: remove the torrent and its files from the throwaway profile
  await page.click('nav >> text=Downloads')
  await page.click('button[aria-label="Remove"]')
  await page.check('input[type=checkbox]')
  await page.click('text=Remove and delete files')
  await page.waitForTimeout(1000)
}
await app.close()
console.log('profile:', userData)
