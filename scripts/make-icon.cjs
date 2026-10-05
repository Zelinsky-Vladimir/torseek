// Renders build/icon.svg to build/icon.png (512x512) with Electron itself.
//   npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const root = join(__dirname, '..')
  const svg = readFileSync(join(root, 'build/icon.svg'), 'utf8')
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, useContentSize: true })
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="512" height="512" ')}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  writeFileSync(join(root, 'build/icon.png'), image.resize({ width: 512, height: 512 }).toPNG())
  console.log('wrote build/icon.png')
  app.quit()
})
