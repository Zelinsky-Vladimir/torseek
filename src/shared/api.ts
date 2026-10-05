// Contract between the Electron main process and the UI (exposed as window.api).
import type { IndexerSettings } from '../core/cardigann/indexer'
import type { SettingsField } from '../core/cardigann/types'
import type { Release } from '../core/release'
import type { IndexerStatus } from '../core/search'
import type { LangSetting } from './i18n'

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
  source?: { indexerName: string; details?: string }
}

export interface TorrentFileInfo {
  name: string
  path: string
  length: number
  progress: number
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
}

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
  openTorrentFile(infoHash: string, path: string): Promise<void>

  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  chooseDownloadDir(): Promise<string | null>
  definitionsStatus(): Promise<DefinitionsStatus>
  /** Pull the latest tracker definitions from the Jackett repo and reload trackers */
  updateDefinitions(): Promise<DefinitionsStatus>
  onIndexersChanged(cb: () => void): () => void
  openExternal(url: string): Promise<void>
}

/** IPC channel names */
export const IPC = {
  invoke: 'api:invoke',
  searchEvent: 'api:search-event',
  torrents: 'api:torrents',
  indexersChanged: 'api:indexers-changed',
} as const

export type ApiMethod = Exclude<keyof Api, 'onSearchEvent' | 'onTorrents' | 'onIndexersChanged'>
