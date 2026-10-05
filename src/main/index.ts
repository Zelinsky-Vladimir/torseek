import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell, type WebContents } from 'electron'
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
import { Library } from './library'
import { lookupTitle } from './titles'
import { Watcher } from './watcher'
import { groupKey } from '../core/release'
import { TorznabServer } from '../core/torznab'
import type { Release as CoreRelease } from '../core/release'
import { randomBytes } from 'node:crypto'

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
let library: Library
let watcher: Watcher
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

function notifyWatch(query: string, count: number) {
  if (!settings().notifyOnComplete || !Notification.isSupported()) return
  const { t, tn } = i18n()
  const n = new Notification({ title: t('notify.watch', { query }), body: tn('notify.watchBody', count), icon: iconPath() })
  n.on('click', () => showWindow('library'))
  n.show()
}

function notifyComplete(name: string) {
  if (!settings().notifyOnComplete || !Notification.isSupported()) return
  const n = new Notification({ title: i18n().t('notify.done'), body: name, icon: iconPath() })
  n.on('click', () => showWindow('downloads'))
  n.show()
}

// --- API implementation (invoked from the renderer via window.api) ----------------

function createApi(sender: () => WebContents): Omit<Api, ApiEvent> {
  const send = (e: SearchEvent) => {
    const wc = sender()
    if (!wc.isDestroyed()) wc.send(IPC.searchEvent, e)
  }

  const resolveRelease = (release: Release) => indexers.get(release.indexerId).resolveDownload(release)

  return {
    async search(req) {
      const searchId = req.searchId || randomUUID()
      const controller = new AbortController()
      searches.set(searchId, controller)
      const started = Date.now()
      const keys = new Set<string>()
      void indexers
        .search(
          { q: req.q.trim(), categories: req.categories },
          {
            concurrency: settings().searchConcurrency,
            timeoutMs: settings().searchTimeoutSec * 1000,
            signal: controller.signal,
            onResults: (indexerId, releases) => {
              for (const r of releases) keys.add(groupKey(r))
              send({ type: 'results', searchId, indexerId, releases })
            },
            onStatus: (status) => send({ type: 'status', searchId, status }),
          },
        )
        .finally(() => {
          searches.delete(searchId)
          if (!controller.signal.aborted) library.addHistory(req.q, keys.size)
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

    async download(release) {
      const target = await resolveRelease(release)
      const res = await torrents.add(target, settings().downloadDir, { indexerName: release.indexerName, details: release.details })
      refreshTray()
      return res
    },
    async getMagnet(release) {
      if (release.magnet) return release.magnet
      const target = await resolveRelease(release)
      if (target.kind === 'magnet') return target.uri
      throw new Error('This tracker only provides .torrent files')
    },
    async addMagnet(uri) {
      return torrents.addMagnet(uri.trim(), settings().downloadDir)
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
    async streamUrl(infoHash, index) {
      return torrents.streamUrl(infoHash, index)
    },

    async getSettings() {
      return settings()
    },
    async updateSettings(patch) {
      store.update((d) => Object.assign(d.settings, patch))
      torrents.setLimits(settings().downloadLimit, settings().uploadLimit)
      if ('openAtLogin' in patch) applyLoginItem()
      if ('language' in patch) refreshTray()
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

    async history() {
      return library.history()
    },
    async removeHistory(query) {
      library.removeHistory(query)
    },
    async clearHistory() {
      library.clearHistory()
    },
    async favorites() {
      return library.favorites()
    },
    async favoriteKeys() {
      return library.favoriteKeys()
    },
    async toggleFavorite(release) {
      const key = groupKey(release)
      const on = !library.favoriteKeys().includes(key)
      if (on) library.addFavorite(release)
      else library.removeFavorite(key)
      return on
    },
    async watches() {
      return library.watches()
    },
    async addWatch(query, filters, meta) {
      const id = library.addWatch(query, filters, meta)
      // First check records what already exists, so only later releases count as new
      void watcher.check(id).then(() => sendToUi(IPC.libraryChanged))
      return library.watch(id)!
    },
    async removeWatch(id) {
      library.removeWatch(id)
    },
    async checkWatch(id) {
      return watcher.check(id)
    },
    async watchHits(id) {
      return library.hits(id)
    },
    async markWatchSeen(id) {
      library.markSeen(id)
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

function createWindow(show = true) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: iconPath(),
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#a1a7b3', height: 44 },
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

function handleMagnetArgs(argv: string[]) {
  const magnet = argv.find((a) => a.startsWith('magnet:'))
  if (!magnet) return
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
    downloadDir: join(app.getPath('downloads'), 'Torseek'),
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
    watchIntervalHours: 6,
    torznabEnabled: false,
    torznabPort: 9118,
    torznabApiKey: randomBytes(16).toString('hex'),
  }
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

  library = new Library(join(app.getPath('userData'), 'library.db'))
  watcher = new Watcher(
    library,
    indexers,
    {
      intervalMs: () => settings().watchIntervalHours * 3600_000,
      showAdult: () => settings().showAdult,
      concurrency: () => Math.max(2, Math.floor(settings().searchConcurrency / 2)),
      timeoutMs: () => settings().searchTimeoutSec * 1000,
      onNew: (w, fresh) => notifyWatch(w.title ?? w.query, fresh.length),
      onChecked: () => sendToUi(IPC.libraryChanged),
    },
    log,
  )
  if (!automation) watcher.start()
  await applyTorznab()

  appUpdater = new AppUpdater((s) => sendToUi(IPC.updateStatus, s))
  if (appUpdater.supported && !automation) setTimeout(() => void appUpdater.check(), 15_000)

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
  watcher?.stop()
  void torznab?.stop()
  library?.close()
  void torrents.destroy().finally(() => app.quit())
})
