// Contract between the Electron main process and the UI (exposed as window.api).
import type { IndexerSettings } from '../core/cardigann/indexer'
import type { SettingsField } from '../core/cardigann/types'
import type { Release } from '../core/release'
import type { IndexerStatus } from '../core/search'
import type { LangSetting } from './i18n'
import type { ResultFilters } from '../core/filters'
import type { AccentId, ThemeSetting } from './themes'
import type { MediaTracks } from '../core/media-tracks'

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
}

export interface ChallengeResult {
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
  /** The title in other languages, searched too on trackers of those languages */
  | { type: 'variants'; searchId: string; names: string[] }

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
  /** Audio / subtitle tracks of the main video, once read */
  tracks?: MediaTracks
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
}

export interface AppSettings {
  /** UI language; 'auto' follows the system */
  language: LangSetting
  downloadDir: string
  /** Languages the user searches in (tracker languages, "en", "ru"…); empty until chosen */
  searchLanguages: string[]
  /** Daily background check switches working trackers on and dead ones off */
  autoManageTrackers: boolean
  /** Ask for a folder on every download (the default folder is preselected) */
  askWhereToSave: boolean
  /** Folders picked lately, newest first */
  recentDirs: string[]
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
  /** Also search the title's name in each tracker's language (Wikidata) */
  searchOtherLanguages: boolean
  theme: ThemeSetting
  accent: AccentId
  /** Hours between background re-checks of watched searches */
  watchIntervalHours: number
  /** Local Torznab API for Sonarr / Radarr */
  torznabEnabled: boolean
  torznabPort: number
  torznabApiKey: string
}

export interface TrackerCheckStatus {
  running: boolean
  checkedAt?: number
  done: number
  total: number
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
  /** Open the site so a Cloudflare / DDoS-Guard check can complete */
  passChallenge(id: string): Promise<ChallengeResult>
  /** Test every tracker in the background (progress via onIndexersChanged) */
  checkTrackers(): Promise<TrackerCheckStatus>
  trackerCheckStatus(): Promise<TrackerCheckStatus>

  /** path: folder for this download; the default folder when omitted */
  download(release: Release, path?: string): Promise<{ infoHash: string }>
  getMagnet(release: Release): Promise<string>
  /** Real audio / subtitle tracks of a release, read from the video header without downloading it */
  probeTracks(release: Release): Promise<MediaTracks>
  addMagnet(uri: string, path?: string): Promise<{ infoHash: string }>
  listTorrents(): Promise<TorrentInfo[]>
  torrentFiles(infoHash: string): Promise<TorrentFileInfo[]>
  onTorrents(cb: (torrents: TorrentInfo[]) => void): () => void
  pauseTorrent(infoHash: string): Promise<void>
  resumeTorrent(infoHash: string): Promise<void>
  removeTorrent(infoHash: string, deleteFiles: boolean): Promise<void>
  openTorrentFolder(infoHash: string): Promise<void>
  openTorrentFile(infoHash: string, index: number): Promise<void>
  setFileSelection(infoHash: string, selected: number[]): Promise<void>

  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  chooseDownloadDir(): Promise<string | null>
  /** Folder picker that doesn't touch the settings */
  chooseFolder(defaultPath?: string): Promise<string | null>
  /** A magnet opened from outside (browser) while "ask where to save" is on */
  onAskSave(cb: (req: { magnet: string; name: string }) => void): () => void
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
  askSave: 'api:ask-save',
} as const

export type ApiEvent = 'onSearchEvent' | 'onTorrents' | 'onIndexersChanged' | 'onUpdateStatus' | 'onNavigate' | 'onLibraryChanged' | 'onAskSave'
export type ApiMethod = Exclude<keyof Api, ApiEvent>
