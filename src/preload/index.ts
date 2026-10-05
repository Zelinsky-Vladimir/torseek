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
  libraryChanged: 'api:library-changed',
  askSave: 'api:ask-save',
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
  'passChallenge', 'checkTrackers', 'trackerCheckStatus',
  'download', 'getMagnet', 'probeTracks', 'addMagnet', 'listTorrents', 'torrentFiles',
  'pauseTorrent', 'resumeTorrent', 'removeTorrent', 'openTorrentFolder', 'openTorrentFile',
  'setFileSelection',
  'getSettings', 'updateSettings', 'chooseDownloadDir', 'chooseFolder', 'openExternal',
  'definitionsStatus', 'updateDefinitions',
  'getMagnetHandler', 'setMagnetHandler', 'updateStatus', 'checkForUpdates', 'installUpdate',
  'history', 'removeHistory', 'clearHistory', 'favorites', 'favoriteKeys', 'toggleFavorite',
  'watches', 'addWatch', 'removeWatch', 'checkWatch', 'watchHits', 'markWatchSeen', 'lookupTitle',
  'torznabStatus', 'regenerateTorznabKey',
]

const api = {
  ...Object.fromEntries(methods.map((m) => [m, call(m)])),
  onSearchEvent: subscribe<SearchEvent>(IPC.searchEvent),
  onTorrents: subscribe<TorrentInfo[]>(IPC.torrents),
  onIndexersChanged: subscribe<void>(IPC.indexersChanged),
  onUpdateStatus: subscribe<UpdateStatus>(IPC.updateStatus),
  onNavigate: subscribe<NavigateTarget>(IPC.navigate),
  onLibraryChanged: subscribe<void>(IPC.libraryChanged),
  onAskSave: subscribe<{ magnet: string; name: string }>(IPC.askSave),
} as unknown as Api

contextBridge.exposeInMainWorld('api', api)
