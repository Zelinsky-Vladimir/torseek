import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type WebContents } from 'electron'
import { HttpClient } from '../core/http'
import type { Api, ApiMethod, AppSettings, Release, SearchEvent } from '../shared/api'
import { IPC } from '../shared/api'
import { IndexerManager, type IndexerStoreShape, type WindowText } from './indexers'
import { JsonStore } from './store'
import { TorrentManager, type TorrentStoreShape } from './torrents'
import { browserUserAgent, electronFetch, sessionCookieStore, trackerSession } from './net'
import { openSiteWindow } from './site-window'
import { DefinitionsUpdater } from './definitions-updater'
import type { DefinitionsStatus } from '../shared/api'
import { resolveLanguage, translator } from '../shared/i18n'

const here = fileURLToPath(new URL('.', import.meta.url))
const log = (msg: string) => console.log(`[torseek] ${msg}`)

interface StoreShape extends IndexerStoreShape, TorrentStoreShape {
  settings: AppSettings
}

// Separate profile for tests/automation so they don't touch the real one
if (process.env.TORSEEK_USER_DATA) app.setPath('userData', process.env.TORSEEK_USER_DATA)

if (!app.requestSingleInstanceLock()) app.quit()

let mainWindow: BrowserWindow | null = null
let store: JsonStore<StoreShape>
let indexers: IndexerManager
let torrents: TorrentManager
let updater: DefinitionsUpdater
const defStatus: DefinitionsStatus = { checkedAt: 0, updating: false }
const searches = new Map<string, AbortController>()

const settings = () => store.get().settings

const bundledDefinitions = () => (app.isPackaged ? join(process.resourcesPath, 'definitions') : join(app.getAppPath(), 'definitions'))
const userDefinitions = () => join(app.getPath('userData'), 'definitions')

function definitionDirs(): string[] {
  // User folder wins, so updated or hand-fixed definitions can be dropped in without a rebuild
  return [bundledDefinitions(), userDefinitions()]
}

async function updateDefinitions(): Promise<DefinitionsStatus> {
  if (defStatus.updating) return defStatus
  defStatus.updating = true
  try {
    const r = await updater.update()
    Object.assign(defStatus, { checkedAt: r.checkedAt, lastResult: r, error: undefined })
    if (r.updated || r.added || r.removed) {
      await indexers.load()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.indexersChanged)
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

// --- API implementation (invoked from the renderer via window.api) ----------------

function createApi(sender: () => WebContents): Omit<Api, 'onSearchEvent' | 'onTorrents' | 'onIndexersChanged'> {
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
      void indexers
        .search(
          { q: req.q.trim(), categories: req.categories },
          {
            concurrency: settings().searchConcurrency,
            timeoutMs: settings().searchTimeoutSec * 1000,
            signal: controller.signal,
            onResults: (indexerId, releases) => send({ type: 'results', searchId, indexerId, releases }),
            onStatus: (status) => send({ type: 'status', searchId, status }),
          },
        )
        .finally(() => {
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
    async signIn(id) {
      return indexers.signIn(id)
    },
    async signInWithBrowser(id) {
      return indexers.signInWithBrowser(id)
    },
    async signOut(id) {
      return indexers.signOut(id)
    },
    async passChallenge(id) {
      return indexers.passChallenge(id)
    },

    async download(release) {
      const target = await resolveRelease(release)
      return torrents.add(target, settings().downloadDir, { indexerName: release.indexerName, details: release.details })
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
    },
    async resumeTorrent(infoHash) {
      await torrents.resume(infoHash)
    },
    async removeTorrent(infoHash, deleteFiles) {
      await torrents.remove(infoHash, deleteFiles)
    },
    async openTorrentFolder(infoHash) {
      shell.showItemInFolder(torrents.contentPath(infoHash))
    },
    async openTorrentFile(infoHash, path) {
      const err = await shell.openPath(join(torrents.snapshot().find((t) => t.infoHash === infoHash)!.path, path))
      if (err) throw new Error(err)
    },

    async getSettings() {
      return settings()
    },
    async updateSettings(patch) {
      store.update((d) => Object.assign(d.settings, patch))
      torrents.setLimits(settings().downloadLimit, settings().uploadLimit)
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
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
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void safeExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(here, '../renderer/index.html'))
}

function handleMagnetArgs(argv: string[]) {
  const magnet = argv.find((a) => a.startsWith('magnet:'))
  if (magnet) void torrents.addMagnet(magnet, settings().downloadDir).catch((e) => log(`magnet: ${e.message}`))
}

app.on('second-instance', (_e, argv) => {
  handleMagnetArgs(argv)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  store = new JsonStore<StoreShape>(join(app.getPath('userData'), 'torseek.json'), {
    settings: {
      language: (process.env.TORSEEK_LANG as AppSettings['language'] | undefined) ?? 'auto',
      downloadDir: join(app.getPath('downloads'), 'Torseek'),
      searchConcurrency: 12,
      searchTimeoutSec: 25,
      seedAfterDownload: true,
      showAdult: false,
      downloadLimit: 0,
      uploadLimit: 0,
    },
    indexers: {},
    torrents: [],
  })

  // All tracker traffic shares one Chromium session with the sign-in / challenge windows
  const ses = trackerSession()
  ses.setUserAgent(browserUserAgent())
  const http = new HttpClient({ fetch: electronFetch(ses), cookieStore: sessionCookieStore(ses), userAgent: browserUserAgent() })
  const secrets = {
    seal: (s: string) => (safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : s),
    open: (s: string) => (s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : s),
  }
  const windowText: WindowText = (key, name) => {
    const lang = resolveLanguage(settings().language, [app.getLocale(), ...app.getPreferredSystemLanguages()])
    return translator(lang).t(`win.${key}`, { name })
  }
  indexers = new IndexerManager(definitionDirs(), http, store, (o) => openSiteWindow({ ...o, parent: mainWindow }), log, secrets, windowText)
  await indexers.load()

  torrents = new TorrentManager(store, join(app.getPath('userData'), 'torrents'), { seedAfterDownload: () => settings().seedAfterDownload }, log)
  torrents.setLimits(settings().downloadLimit, settings().uploadLimit)
  await torrents.init()

  updater = new DefinitionsUpdater(bundledDefinitions(), userDefinitions())
  defStatus.checkedAt = await updater.lastChecked()
  // Refresh definitions in the background at most once a day
  if (Date.now() - defStatus.checkedAt > 24 * 3600_000 && !process.env.TORSEEK_NO_UPDATE) setTimeout(() => void updateDefinitions(), 5000)

  registerIpc()
  createWindow()
  handleMagnetArgs(process.argv)

  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IPC.torrents, torrents.snapshot())
  }, 1000)
})

app.on('window-all-closed', () => app.quit())

let quitting = false
app.on('before-quit', (e) => {
  if (quitting || !torrents) return
  e.preventDefault()
  quitting = true
  store.flush()
  void torrents.destroy().finally(() => app.quit())
})
