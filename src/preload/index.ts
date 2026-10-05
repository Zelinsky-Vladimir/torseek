import { contextBridge, ipcRenderer } from 'electron'
import type { Api, ApiMethod, NavigateTarget, SearchEvent, TorrentInfo, UpdateStatus } from '../shared/api'

// Kept literal (not imported) so the sandboxed preload bundle stays dependency-free
const IPC = {
  invoke: 'api:invoke',
  searchEvent: 'api:search-event',
  torrents: 'api:torrents',
  indexersChanged: 'api:indexers-changed',
  updateStatus: 'api:update-status',
  navigate: 'api:navigate',
}

const call =
  (method: ApiMethod) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(IPC.invoke, method, args)

const subscribe =
  <T>(channel: string) =>
  (cb: (payload: T) => void) => {
    const listener = (_: unknown, payload: T) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }

const methods: ApiMethod[] = [
  'search', 'cancelSearch',
  'listIndexers', 'setIndexerEnabled', 'updateIndexerSettings', 'testIndexer',
  'signIn', 'signInWithBrowser', 'signOut', 'passChallenge',
  'download', 'getMagnet', 'addMagnet', 'listTorrents', 'torrentFiles',
  'pauseTorrent', 'resumeTorrent', 'removeTorrent', 'openTorrentFolder', 'openTorrentFile',
  'setFileSelection', 'streamUrl',
  'getSettings', 'updateSettings', 'chooseDownloadDir', 'openExternal',
  'definitionsStatus', 'updateDefinitions',
  'getMagnetHandler', 'setMagnetHandler', 'updateStatus', 'checkForUpdates', 'installUpdate',
]

const api = {
  ...Object.fromEntries(methods.map((m) => [m, call(m)])),
  onSearchEvent: subscribe<SearchEvent>(IPC.searchEvent),
  onTorrents: subscribe<TorrentInfo[]>(IPC.torrents),
  onIndexersChanged: subscribe<void>(IPC.indexersChanged),
  onUpdateStatus: subscribe<UpdateStatus>(IPC.updateStatus),
  onNavigate: subscribe<NavigateTarget>(IPC.navigate),
} as unknown as Api

contextBridge.exposeInMainWorld('api', api)
