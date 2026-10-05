import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, safeStorage, shell, type WebContents } from 'electron'
import { HttpClient } from '../core/http'
import type { Api, ApiEvent, ApiMethod, AppSettings, DefinitionsStatus, NavigateTarget, Release, SearchEvent } from '../shared/api'
import { IPC } from '../shared/api'
import { resolveLanguage, translator } from '../shared/i18n'
import { AppUpdater } from './app-updater'
import { DefinitionsUpdater } from './definitions-updater'
import { IndexerManager, type IndexerStoreShape, type WindowText } from './indexers'
import { browserUserAgent, electronFetch, sessionCookieStore, trackerSession } from './net'
import { openSiteWindow } from './site-window'
import { JsonStore } from './store'
import { TorrentManager, type TorrentStoreShape } from './torrents'
import { AppTray } from './tray'
import { lookupTitle } from './titles'
import { findTitleNames, variantFor } from './title-names'
import { resolveTheme, THEMES } from '../shared/themes'
import { releaseHash } from '../core/release'
import { scrapeAll, type SwarmStats } from '../core/scrape'
import { TorznabServer } from '../core/torznab'
import type { Release as CoreRelease } from '../core/release'
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'

const here = fileURLToPath(new URL('.', import.meta.url))
const log = (msg: string) => console.log(`[torseek] ${msg}`)


interface StoreShape extends IndexerStoreShape, TorrentStoreShape {
  settings: AppSettings
  /** One-time hints already shown */
  seen?: { trayHint?: boolean }
}

// Separate profile for tests/automation so they don't touch the real one
if (process.env.TORSEEK_USER_DATA) app.setPath('userData', process.env.TORSEEK_USER_DATA)

if (!app.requestSingleInstanceLock()) app.quit()

let mainWindow: BrowserWindow | null = null
let store: JsonStore<StoreShape>
let indexers: IndexerManager
let torrents: TorrentManager
let definitions: DefinitionsUpdater
let appUpdater: AppUpdater
let tray: AppTray | null = null
let torznab: TorznabServer | null = null
let torznabError: string | undefined
let quitting = false
const defStatus: DefinitionsStatus = { checkedAt: 0, updating: false }
const searches = new Map<string, AbortController>()

const settings = () => store.get().settings
const i18n = () => translator(resolveLanguage(settings().language, [app.getLocale(), ...app.getPreferredSystemLanguages()]))

const resource = (...p: string[]) => (app.isPackaged ? join(process.resourcesPath, ...p) : join(app.getAppPath(), ...p))
const bundledDefinitions = () => resource('definitions')
const userDefinitions = () => join(app.getPath('userData'), 'definitions')
const iconPath = () => (app.isPackaged ? resource('icon.png') : resource('build', 'icon.png'))

function definitionDirs(): string[] {
  // User folder wins, so updated or hand-fixed definitions can be dropped in without a rebuild
  return [bundledDefinitions(), userDefinitions()]
}

function sendToUi(channel: string, payload?: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function showWindow(page?: NavigateTarget) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  mainWindow!.show()
  if (mainWindow!.isMinimized()) mainWindow!.restore()
  mainWindow!.focus()
  if (page) sendToUi(IPC.navigate, page)
}

let progressTimer: ReturnType<typeof setTimeout> | undefined
async function checkTrackers() {
  const s = settings()
  await indexers.checkAll(s.searchLanguages, {
    manage: s.autoManageTrackers,
    adult: s.showAdult,
    concurrency: Math.max(4, Math.floor(s.searchConcurrency / 2)),
    // The tracker list re-renders on each event; one per second is plenty
    onProgress: () => {
      if (!indexers.checkStatus.running) {
        clearTimeout(progressTimer)
        progressTimer = undefined
        return sendToUi(IPC.indexersChanged)
      }
      progressTimer ??= setTimeout(() => {
        progressTimer = undefined
        sendToUi(IPC.indexersChanged)
      }, 1000)
    },
  })
}

// Recent scrape answers, so re-running a search doesn't ask again for the same torrents
const seedCache = new Map<string, { stats: SwarmStats; at: number }>()
async function liveSeeds(hashes: string[]): Promise<Record<string, SwarmStats>> {
  const fresh = (h: string) => (seedCache.get(h)?.at ?? 0) > Date.now() - 10 * 60_000
  const missing = hashes.filter((h) => !fresh(h))
  if (missing.length) {
    for (const [h, stats] of await scrapeAll(missing)) seedCache.set(h, { stats, at: Date.now() })
    if (seedCache.size > 20_000) seedCache.clear()
  }
  return Object.fromEntries(hashes.flatMap((h) => (seedCache.has(h) ? [[h, seedCache.get(h)!.stats]] : [])))
}

async function updateDefinitions(): Promise<DefinitionsStatus> {
  if (defStatus.updating) return defStatus
  defStatus.updating = true
  try {
    const r = await definitions.update()
    Object.assign(defStatus, { checkedAt: r.checkedAt, lastResult: r, error: undefined })
    if (r.updated || r.added || r.removed) {
      await indexers.load()
      sendToUi(IPC.indexersChanged)
    }
    log(`definitions: ${r.updated} updated, ${r.added} added, ${r.removed} removed`)
  } catch (e) {
    defStatus.error = (e as Error).message
    log(`definitions update failed: ${defStatus.error}`)
  } finally {
    defStatus.updating = false
  }
  return defStatus
}

function safeExternal(url: string) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened')
  return shell.openExternal(url)
}

// --- Torznab API for Sonarr / Radarr -----------------------------------------------------

async function applyTorznab() {
  await torznab?.stop()
  torznab = null
  torznabError = undefined
  const s = settings()
  if (!s.torznabEnabled) return
  const server = new TorznabServer(
    {
      indexers: () => indexers.enabledIndexers().map((ix) => ({ id: ix.id, name: ix.name })),
      search: async (query, ids, timeoutMs) => {
        const found: CoreRelease[] = []
        const list = indexers.enabledIndexers().filter((ix) => ids.includes(ix.id))
        await indexers.search(query, { concurrency: s.searchConcurrency, timeoutMs, onResults: (_, r) => found.push(...r), onStatus: () => {} }, list)
        return found
      },
      resolve: (r) => indexers.get(r.indexerId).resolveDownload(r),
    },
    { port: s.torznabPort, apiKey: s.torznabApiKey, timeoutMs: s.searchTimeoutSec * 1000, log },
  )
  try {
    await server.start()
    torznab = server
    log(`torznab API on http://127.0.0.1:${server.port}`)
  } catch (e) {
    torznabError = (e as Error).message
    log(`torznab: ${torznabError}`)
  }
}

// --- OS integration -------------------------------------------------------------------

// In dev the protocol handler must point at electron.exe + the app path
const protocolArgs = (): [string, string, string[]] | [string] =>
  process.defaultApp ? ['magnet', process.execPath, [app.getAppPath()]] : ['magnet']

function applyLoginItem() {
  if (process.platform === 'linux') return
  app.setLoginItemSettings({ openAtLogin: settings().openAtLogin, args: ['--hidden'] })
}

function refreshTray() {
  if (!tray) return
  const { t, tn } = i18n()
  const active = torrents.activeCount()
  tray.update({
    open: t('tray.open'),
    pauseAll: t('tray.pauseAll'),
    resumeAll: t('tray.resumeAll'),
    quit: t('tray.quit'),
    tooltip: active ? `Torseek — ${tn('tray.active', active)}` : 'Torseek',
  })
}

function notifyComplete(name: string) {
  if (!settings().notifyOnComplete || !Notification.isSupported()) return
  const n = new Notification({ title: i18n().t('notify.done'), body: name, icon: iconPath() })
  n.on('click', () => showWindow('downloads'))
  n.show()
}

function notifyUpdate(version: string) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: i18n().t('upd.ready', { version }), body: i18n().t('upd.notifyBody'), icon: iconPath() })
  n.on('click', () => appUpdater.install())
  n.show()
}

// --- API implementation (invoked from the renderer via window.api) ----------------

function createApi(sender: () => WebContents): Omit<Api, ApiEvent> {
  const send = (e: SearchEvent) => {
    const wc = sender()
    if (!wc.isDestroyed()) wc.send(IPC.searchEvent, e)
  }

  // Collects info hashes as results stream in and scrapes them in batches
  const liveSeedsFor = (searchId: string, aborted: () => boolean) => {
    const pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = async () => {
      clearTimeout(timer)
      timer = undefined
      const hashes = [...pending]
      pending.clear()
      if (!hashes.length || aborted()) return
      const stats = await liveSeeds(hashes).catch((e) => (log(`scrape: ${(e as Error).message}`), {}))
      if (Object.keys(stats).length && !aborted()) send({ type: 'seeds', searchId, stats })
    }
    return {
      add(releases: Release[]) {
        for (const r of releases) {
          const h = releaseHash(r)
          if (h) pending.add(h)
        }
        if (pending.size) timer ??= setTimeout(() => void flush(), 1200)
      },
      flush: () => void flush(),
    }
  }

  const resolveRelease = (release: Release) => indexers.get(release.indexerId).resolveDownload(release)

  return {
    async search(req) {
      const searchId = req.searchId || randomUUID()
      const controller = new AbortController()
      searches.set(searchId, controller)
      const started = Date.now()
      const q = req.q.trim()
      const live = settings().liveSeeds ? liveSeedsFor(searchId, () => controller.signal.aborted) : undefined
      const names = settings().searchOtherLanguages ? findTitleNames(q).catch((e) => (log(`title names: ${(e as Error).message}`), null)) : Promise.resolve(null)
      void names.then((n) => {
        if (!n || controller.signal.aborted) return
        const used = new Set(indexers.enabledIndexers().map((ix) => variantFor(n, ix.meta.language, q)))
        used.delete(undefined)
        if (used.size) send({ type: 'variants', searchId, names: [...used] as string[] })
      })
      void indexers
        .search(
          { q, categories: req.categories },
          {
            concurrency: settings().searchConcurrency,
            timeoutMs: settings().searchTimeoutSec * 1000,
            signal: controller.signal,
            onResults: (indexerId, releases) => {
              live?.add(releases)
              send({ type: 'results', searchId, indexerId, releases })
            },
            onStatus: (status) => send({ type: 'status', searchId, status }),
            extraQueries: async (ix) => {
              const n = await names
              const v = n && variantFor(n, ix.meta.language, q)
              return v ? [v] : []
            },
          },
        )
        .finally(() => {
          live?.flush()
          searches.delete(searchId)
          send({ type: 'done', searchId, elapsedMs: Date.now() - started })
        })
      return { searchId }
    },
    async cancelSearch(searchId) {
      searches.get(searchId)?.abort()
    },

    async listIndexers() {
      return indexers.list()
    },
    async setIndexerEnabled(id, enabled) {
      return indexers.setEnabled(id, enabled)
    },
    async updateIndexerSettings(id, values) {
      return indexers.updateSettings(id, values)
    },
    async testIndexer(id) {
      return indexers.test(id)
    },
    async passChallenge(id) {
      return indexers.passChallenge(id)
    },
    async checkTrackers() {
      void checkTrackers()
      return indexers.checkStatus
    },
    async trackerCheckStatus() {
      return { ...indexers.checkStatus, checkedAt: indexers.checkStatus.checkedAt ?? (indexers.lastCheckedAt() || undefined) }
    },

    async download(release, path) {
      const target = await resolveRelease(release)
      const res = await torrents.add(target, useDir(path), { indexerName: release.indexerName, details: release.details }, release.title)
      refreshTray()
      return res
    },
    async probeTracks(release) {
      const target = await resolveRelease(release)
      return torrents.probe(target, await torrents.infoHashOf(target))
    },
    async getMagnet(release) {
      if (release.magnet) return release.magnet
      const target = await resolveRelease(release)
      if (target.kind === 'magnet') return target.uri
      throw new Error('This tracker only provides .torrent files')
    },
    async addMagnet(uri, path) {
      const res = await torrents.addMagnet(uri.trim(), useDir(path))
      refreshTray()
      return res
    },
    async listTorrents() {
      return torrents.snapshot()
    },
    async torrentFiles(infoHash) {
      return torrents.files(infoHash)
    },
    async pauseTorrent(infoHash) {
      await torrents.pause(infoHash)
      refreshTray()
    },
    async resumeTorrent(infoHash) {
      await torrents.resume(infoHash)
      refreshTray()
    },
    async removeTorrent(infoHash, deleteFiles) {
      await torrents.remove(infoHash, deleteFiles)
      refreshTray()
    },
    async openTorrentFolder(infoHash) {
      shell.showItemInFolder(torrents.contentPath(infoHash))
    },
    async openTorrentFile(infoHash, index) {
      const err = await shell.openPath(torrents.filePath(infoHash, index))
      if (err) throw new Error(err)
    },
    async setFileSelection(infoHash, selected) {
      await torrents.setFileSelection(infoHash, selected)
    },

    async getSettings() {
      return settings()
    },
    async updateSettings(patch) {
      store.update((d) => Object.assign(d.settings, patch))
      torrents.setLimits(settings().downloadLimit, settings().uploadLimit)
      if ('openAtLogin' in patch) applyLoginItem()
      if ('language' in patch) refreshTray()
      if ('theme' in patch) applyThemeSource()
      else if ('accent' in patch) applyWindowColors()
      if ('torznabEnabled' in patch || 'torznabPort' in patch) await applyTorznab()
      return settings()
    },
    async chooseDownloadDir() {
      const res = await dialog.showOpenDialog(mainWindow!, {
        defaultPath: settings().downloadDir,
        properties: ['openDirectory', 'createDirectory'],
      })
      if (res.canceled || !res.filePaths[0]) return null
      store.update((d) => (d.settings.downloadDir = res.filePaths[0]))
      return res.filePaths[0]
    },
    async chooseFolder(defaultPath) {
      const res = await dialog.showOpenDialog(mainWindow!, { defaultPath: defaultPath ?? settings().downloadDir, properties: ['openDirectory', 'createDirectory'] })
      return res.canceled ? null : (res.filePaths[0] ?? null)
    },
    async openExternal(url) {
      await safeExternal(url)
    },
    async definitionsStatus() {
      return defStatus
    },
    updateDefinitions,

    async getMagnetHandler() {
      return app.isDefaultProtocolClient(...(protocolArgs() as [string]))
    },
    async setMagnetHandler(on) {
      const args = protocolArgs() as [string]
      if (on) app.setAsDefaultProtocolClient(...args)
      else app.removeAsDefaultProtocolClient(...args)
      return app.isDefaultProtocolClient(...args)
    },

    async updateStatus() {
      return appUpdater.status
    },
    async checkForUpdates() {
      return appUpdater.check()
    },
    async installUpdate() {
      quitting = true
      appUpdater.install()
    },

    async torznabStatus() {
      return { running: !!torznab, port: torznab?.port, error: torznabError }
    },
    async regenerateTorznabKey() {
      store.update((d) => (d.settings.torznabApiKey = randomBytes(16).toString('hex')))
      await applyTorznab()
      return settings()
    },
    async lookupTitle(query) {
      return settings().showTitleInfo ? lookupTitle(query) : null
    },
  }
}

function registerIpc() {
  ipcMain.handle(IPC.invoke, async (event, method: ApiMethod, args: unknown[]) => {
    const api = createApi(() => event.sender) as Record<string, (...a: unknown[]) => Promise<unknown>>
    const fn = api[method]
    if (typeof fn !== 'function') throw new Error(`Unknown API method ${method}`)
    return fn(...args)
  })
}

// --- window ---------------------------------------------------------------------------

const windowPalette = () => THEMES[resolveTheme(store ? settings().theme : undefined, nativeTheme.shouldUseDarkColors)]

// Native parts (scrollbars, menus, the title bar buttons) follow the chosen theme
function applyThemeSource() {
  const theme = settings().theme
  nativeTheme.themeSource = !theme || theme === 'system' ? 'system' : windowPalette().scheme
  applyWindowColors()
}

function applyWindowColors() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const p = windowPalette()
  mainWindow.setBackgroundColor(p.bg)
  if (process.platform !== 'darwin') mainWindow.setTitleBarOverlay({ color: '#00000000', symbolColor: p.muted, height: 44 })
}

function createWindow(show = true) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: iconPath(),
    backgroundColor: windowPalette().bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: windowPalette().muted, height: 44 },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  if (show) mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void safeExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault()
  })
  // Close = hide to tray while downloads keep running
  mainWindow.on('close', (e) => {
    if (quitting || !settings().closeToTray || !tray) return
    e.preventDefault()
    mainWindow?.hide()
    if (!store.get().seen?.trayHint && Notification.isSupported()) {
      store.update((d) => (d.seen = { ...d.seen, trayHint: true }))
      new Notification({ title: 'Torseek', body: i18n().t('notify.tray'), icon: iconPath() }).show()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(here, '../renderer/index.html'))
}

/** The folder for a download; a chosen one goes to the top of the recent list */
function useDir(path?: string): string {
  if (!path || path === settings().downloadDir) return settings().downloadDir
  store.update((d) => {
    d.settings.recentDirs = [path, ...(d.settings.recentDirs ?? []).filter((p) => p !== path)].slice(0, 5)
  })
  return path
}

function handleMagnetArgs(argv: string[]) {
  const magnet = argv.find((a) => a.startsWith('magnet:'))
  if (!magnet) return
  if (settings().askWhereToSave && mainWindow && !mainWindow.isDestroyed()) {
    showWindow('downloads')
    const name = new URLSearchParams(magnet.split('?')[1] ?? '').get('dn') || magnet.slice(0, 60)
    const send = () => sendToUi(IPC.askSave, { magnet, name })
    if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', () => setTimeout(send, 500))
    else send()
    return
  }
  void torrents
    .addMagnet(magnet, settings().downloadDir)
    .then(() => {
      refreshTray()
      showWindow('downloads')
    })
    .catch((e) => log(`magnet: ${e.message}`))
}

app.on('second-instance', (_e, argv) => {
  handleMagnetArgs(argv)
  showWindow()
})

// macOS hands protocol links over this event
app.on('open-url', (e, url) => {
  e.preventDefault()
  if (torrents) handleMagnetArgs([url])
})

app.whenReady().then(async () => {
  const defaultSettings: AppSettings = {
    language: (process.env.TORSEEK_LANG as AppSettings['language'] | undefined) ?? 'auto',
    // TORSEEK_DOWNLOAD_DIR keeps test runs out of the real Downloads folder
    downloadDir: process.env.TORSEEK_DOWNLOAD_DIR ?? join(app.getPath('downloads'), 'Torseek'),
    askWhereToSave: true,
    searchLanguages: [],
    autoManageTrackers: true,
    recentDirs: [],
    searchConcurrency: 12,
    searchTimeoutSec: 25,
    seedAfterDownload: true,
    showAdult: false,
    downloadLimit: 0,
    uploadLimit: 0,
    closeToTray: true,
    notifyOnComplete: true,
    openAtLogin: false,
    showTitleInfo: true,
    searchOtherLanguages: true,
    liveSeeds: true,
    theme: 'system',
    accent: 'violet',
    torznabEnabled: false,
    torznabPort: 9118,
    torznabApiKey: randomBytes(16).toString('hex'),
  }
  // The Library (watches, favorites, history) was removed in 0.2.7; drop its database
  for (const f of ['library.db', 'library.db-wal', 'library.db-shm']) void rm(join(app.getPath('userData'), f), { force: true }).catch(() => {})
  store = new JsonStore<StoreShape>(join(app.getPath('userData'), 'torseek.json'), { settings: defaultSettings, indexers: {}, torrents: [] })
  // Settings added in later versions get their defaults in older profiles
  store.update((d) => {
    d.settings = { ...defaultSettings, ...d.settings }
  })

  // All tracker traffic shares one Chromium session with the sign-in / challenge windows
  const ses = trackerSession()
  ses.setUserAgent(browserUserAgent())
  const http = new HttpClient({ fetch: electronFetch(ses), cookieStore: sessionCookieStore(ses), userAgent: browserUserAgent() })
  const secrets = {
    seal: (s: string) => (safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : s),
    open: (s: string) => (s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : s),
  }
  const windowText: WindowText = (key, name) => i18n().t(`win.${key}`, { name })
  indexers = new IndexerManager(definitionDirs(), http, store, (o) => openSiteWindow({ ...o, parent: mainWindow }), log, secrets, windowText)
  await indexers.load()

  torrents = new TorrentManager(
    store,
    join(app.getPath('userData'), 'torrents'),
    {
      seedAfterDownload: () => settings().seedAfterDownload,
      onComplete: (rec) => {
        notifyComplete(rec.name)
        refreshTray()
      },
    },
    log,
  )
  torrents.setLimits(settings().downloadLimit, settings().uploadLimit)
  await torrents.init()

  definitions = new DefinitionsUpdater(bundledDefinitions(), userDefinitions())
  defStatus.checkedAt = await definitions.lastChecked()
  const automation = !!process.env.TORSEEK_NO_UPDATE
  // Refresh definitions in the background at most once a day
  if (Date.now() - defStatus.checkedAt > 24 * 3600_000 && !automation) setTimeout(() => void updateDefinitions(), 5000)
  // Daily tracker check, once the user has said which languages they search in
  const dailyCheck = () => {
    if (settings().searchLanguages.length && Date.now() - indexers.lastCheckedAt() > 24 * 3600_000) void checkTrackers()
  }
  if (!automation) {
    setTimeout(dailyCheck, 60_000)
    setInterval(dailyCheck, 3600_000)
  }

  await applyTorznab()

  let announced: string | undefined
  appUpdater = new AppUpdater((s) => {
    sendToUi(IPC.updateStatus, s)
    if (s.state === 'ready' && s.available && s.available !== announced) {
      announced = s.available
      notifyUpdate(s.available)
    }
  })
  if (appUpdater.supported && !automation) {
    setTimeout(() => void appUpdater.check(), 15_000)
    // Every push to main is a release, so look often (electron-updater reads the
    // releases feed on github.com, not the rate-limited REST API)
    setInterval(() => {
      if (!['checking', 'downloading', 'ready'].includes(appUpdater.status.state)) void appUpdater.check()
    }, 60_000)
  }

  registerIpc()
  try {
    tray = new AppTray(iconPath(), {
      open: () => showWindow(),
      pauseAll: () => void torrents.pauseAll().then(refreshTray),
      resumeAll: () => void torrents.resumeAll().then(refreshTray),
      quit: () => app.quit(),
    })
    refreshTray()
  } catch (e) {
    log(`tray unavailable: ${(e as Error).message}`)
  }
  applyLoginItem()

  // Launched at login: start in the tray
  nativeTheme.themeSource = settings().theme === 'system' ? 'system' : windowPalette().scheme
  nativeTheme.on('updated', applyWindowColors)
  createWindow(!process.argv.includes('--hidden'))
  handleMagnetArgs(process.argv)

  let lastActive = -1
  setInterval(() => {
    sendToUi(IPC.torrents, torrents.snapshot())
    const active = torrents.activeCount()
    if (active !== lastActive) {
      lastActive = active
      refreshTray()
    }
  }, 1000)
})

// With the tray the app keeps running until "Quit"
app.on('window-all-closed', () => {
  if (!tray) app.quit()
})

// Flush state and stop the torrent client cleanly, then really quit
let stopping = false
app.on('before-quit', (e) => {
  quitting = true
  if (!torrents || stopping) return
  e.preventDefault()
  stopping = true
  store.flush()
  tray?.destroy()
  void torznab?.stop()
  // Closing peer connections can stall on a dead socket; never let that keep the app alive
  const stop = torrents.destroy().catch((e) => log(`shutdown: ${(e as Error).message}`))
  void Promise.race([stop, new Promise((resolve) => setTimeout(resolve, 5000))]).finally(() => app.quit())
})
