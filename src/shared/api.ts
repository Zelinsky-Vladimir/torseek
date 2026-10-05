// Contract between the Electron main process and the UI (exposed as window.api).
import type { IndexerSettings } from '../core/cardigann/indexer'
import type { SettingsField } from '../core/cardigann/types'
import type { Release } from '../core/release'
import type { IndexerStatus } from '../core/search'
import type { LangSetting } from './i18n'
import type { ResultFilters } from '../core/filters'

export type { ResultFilters }

export type { Release, IndexerStatus, IndexerSettings, SettingsField }

export interface IndexerInfo {
  id: string
  name: string
  description?: string
  language?: string
  type: string
  links: string[]
  siteLink: string
  enabled: boolean
  /** Why it can't be enabled yet (e.g. needs login) */
  unsupported?: string
  /** Top-level Torznab categories, e.g. [2000, 5000] */
  categories: number[]
  settings: SettingsField[]
  values: IndexerSettings
  health?: { state: IndexerStatus['state']; error?: string; count?: number; at: number }
  /** Login method from the definition (form/post/get/cookie/oneurl); undefined = no account needed */
  loginMethod?: string
  /** Last known result of a sign-in or login test */
  signedIn?: boolean
}

export interface AuthResult {
  ok: boolean
  message?: string
  info: IndexerInfo
}

export interface SearchRequest {
  /** Chosen by the caller so events can be matched before search() resolves */
  searchId: string
  q: string
  categories?: number[]
}

export type SearchEvent =
  | { type: 'status'; searchId: string; status: IndexerStatus }
  | { type: 'results'; searchId: string; indexerId: string; releases: Release[] }
  | { type: 'done'; searchId: string; elapsedMs: number }

export type TorrentState = 'metadata' | 'downloading' | 'seeding' | 'paused' | 'done' | 'error'

export interface TorrentInfo {
  infoHash: string
  name: string
  state: TorrentState
  progress: number
  length: number
  downloaded: number
  uploaded: number
  downloadSpeed: number
  uploadSpeed: number
  numPeers: number
  /** ms */
  timeRemaining: number
  path: string
  addedAt: number
  error?: string
  /** Some files are excluded; length/progress cover the selected ones */
  partial?: boolean
  source?: { indexerName: string; details?: string }
}

export interface TorrentFileInfo {
  index: number
  name: string
  path: string
  length: number
  downloaded: number
  progress: number
  /** Included in the download */
  selected: boolean
  /** Video/audio the built-in player can try */
  playable: boolean
}

export interface AppSettings {
  /** UI language; 'auto' follows the system */
  language: LangSetting
  downloadDir: string
  searchConcurrency: number
  searchTimeoutSec: number
  seedAfterDownload: boolean
  showAdult: boolean
  /** KB/s, 0 = unlimited */
  downloadLimit: number
  uploadLimit: number
  /** Closing the window hides it to the tray */
  closeToTray: boolean
  notifyOnComplete: boolean
  /** Launch hidden at OS login */
  openAtLogin: boolean
  /** Movie/series card from Cinemeta above results */
  showTitleInfo: boolean
  /** Hours between background re-checks of watched searches */
  watchIntervalHours: number
  /** Local Torznab API for Sonarr / Radarr */
  torznabEnabled: boolean
  torznabPort: number
  torznabApiKey: string
}

export interface TorznabStatus {
  running: boolean
  port?: number
  error?: string
}

export interface HistoryItem {
  query: string
  results: number
  searchedAt: number
}

export interface FavoriteItem {
  key: string
  release: Release
  addedAt: number
}

export interface Watch {
  id: number
  query: string
  filters: ResultFilters
  title?: string
  poster?: string
  createdAt: number
  checkedAt?: number
  /** Unseen new releases */
  newCount: number
}

export interface WatchHit {
  key: string
  release: Release
  foundAt: number
  seen: boolean
}

export interface TitleInfo {
  /** IMDb id */
  id: string
  type: 'movie' | 'series'
  name: string
  year?: string
  poster?: string
  rating?: number
  genres?: string[]
  description?: string
  url?: string
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error' | 'unsupported'
  /** Running version */
  version: string
  /** Version being downloaded / ready to install */
  available?: string
  percent?: number
  error?: string
}

export type NavigateTarget = 'search' | 'downloads' | 'library' | 'trackers' | 'settings'

export interface DefinitionsStatus {
  checkedAt: number
  updating: boolean
  lastResult?: { updated: number; added: number; removed: number; total: number }
  error?: string
}

export interface Api {
  search(req: SearchRequest): Promise<{ searchId: string }>
  cancelSearch(searchId: string): Promise<void>
  onSearchEvent(cb: (e: SearchEvent) => void): () => void

  listIndexers(): Promise<IndexerInfo[]>
  setIndexerEnabled(id: string, enabled: boolean): Promise<IndexerInfo>
  updateIndexerSettings(id: string, values: IndexerSettings): Promise<IndexerInfo>
  testIndexer(id: string): Promise<IndexerInfo>
  /** Log in with the credentials saved in the tracker's settings */
  signIn(id: string): Promise<AuthResult>
  /** Open the site in a window and let the user sign in by hand */
  signInWithBrowser(id: string): Promise<AuthResult>
  signOut(id: string): Promise<IndexerInfo>
  /** Open the site so a Cloudflare / DDoS-Guard check can complete */
  passChallenge(id: string): Promise<AuthResult>

  download(release: Release): Promise<{ infoHash: string }>
  getMagnet(release: Release): Promise<string>
  addMagnet(uri: string): Promise<{ infoHash: string }>
  listTorrents(): Promise<TorrentInfo[]>
  torrentFiles(infoHash: string): Promise<TorrentFileInfo[]>
  onTorrents(cb: (torrents: TorrentInfo[]) => void): () => void
  pauseTorrent(infoHash: string): Promise<void>
  resumeTorrent(infoHash: string): Promise<void>
  removeTorrent(infoHash: string, deleteFiles: boolean): Promise<void>
  openTorrentFolder(infoHash: string): Promise<void>
  openTorrentFile(infoHash: string, index: number): Promise<void>
  setFileSelection(infoHash: string, selected: number[]): Promise<void>
  /** http://127.0.0.1 URL streaming the file while it downloads */
  streamUrl(infoHash: string, index: number): Promise<string>

  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  chooseDownloadDir(): Promise<string | null>
  definitionsStatus(): Promise<DefinitionsStatus>
  /** Pull the latest tracker definitions from the Jackett repo and reload trackers */
  updateDefinitions(): Promise<DefinitionsStatus>
  onIndexersChanged(cb: () => void): () => void

  /** Whether Torseek is the OS handler for magnet: links */
  getMagnetHandler(): Promise<boolean>
  setMagnetHandler(on: boolean): Promise<boolean>

  updateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  installUpdate(): Promise<void>
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
  /** Main process asks the UI to switch page (e.g. a notification was clicked) */
  onNavigate(cb: (page: NavigateTarget) => void): () => void

  history(): Promise<HistoryItem[]>
  removeHistory(query: string): Promise<void>
  clearHistory(): Promise<void>
  favorites(): Promise<FavoriteItem[]>
  favoriteKeys(): Promise<string[]>
  /** Returns whether it is a favorite afterwards */
  toggleFavorite(release: Release): Promise<boolean>
  watches(): Promise<Watch[]>
  addWatch(query: string, filters: ResultFilters, meta?: { title?: string; poster?: string }): Promise<Watch>
  removeWatch(id: number): Promise<void>
  checkWatch(id: number): Promise<Watch | undefined>
  watchHits(id: number): Promise<WatchHit[]>
  markWatchSeen(id: number): Promise<void>
  lookupTitle(query: string): Promise<TitleInfo | null>
  torznabStatus(): Promise<TorznabStatus>
  regenerateTorznabKey(): Promise<AppSettings>
  /** Watches / favorites changed in the background */
  onLibraryChanged(cb: () => void): () => void
  openExternal(url: string): Promise<void>
}

/** IPC channel names */
export const IPC = {
  invoke: 'api:invoke',
  searchEvent: 'api:search-event',
  torrents: 'api:torrents',
  indexersChanged: 'api:indexers-changed',
  updateStatus: 'api:update-status',
  navigate: 'api:navigate',
  libraryChanged: 'api:library-changed',
} as const

export type ApiEvent = 'onSearchEvent' | 'onTorrents' | 'onIndexersChanged' | 'onUpdateStatus' | 'onNavigate' | 'onLibraryChanged'
export type ApiMethod = Exclude<keyof Api, ApiEvent>
