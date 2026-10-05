import type { CategoryMap } from './categories'
import type { SettingsField } from './cardigann/types'
import type { Release } from './release'

// What the app needs from a tracker, whether it's driven by a Cardigann YAML
// definition or written by hand in TypeScript (sites the YAML format can't express).
// Only public trackers (no account) are supported.

export interface SearchQuery {
  q: string
  /** Torznab category ids, e.g. [2000] for all movies */
  categories?: number[]
  limit?: number
}

export type SettingValue = string | boolean | string[]
export type IndexerSettings = Record<string, SettingValue>

export type DownloadTarget = { kind: 'magnet'; uri: string } | { kind: 'torrent'; data: Uint8Array }

export type LogFn = (level: 'debug' | 'warn' | 'error', msg: string) => void

export interface IndexerMeta {
  id: string
  name: string
  description?: string
  language?: string
  type: 'public' | 'semi-private' | 'private' | string
  links: string[]
}

export interface Indexer {
  readonly id: string
  readonly name: string
  readonly meta: IndexerMeta
  readonly categories: CategoryMap
  readonly settingsFields: SettingsField[]
  readonly siteLink: string

  updateSettings(settings: IndexerSettings): void
  search(query: SearchQuery, signal?: AbortSignal): Promise<Release[]>
  resolveDownload(release: Pick<Release, 'link' | 'magnet' | 'title'>, signal?: AbortSignal): Promise<DownloadTarget>

  /** False while the site answers with a Cloudflare / DDoS-Guard check page */
  checkAccess(signal?: AbortSignal): Promise<boolean>
}

export class LoginRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoginRequiredError'
  }
}

export class CloudflareError extends Error {
  constructor(readonly origin: string) {
    super('Blocked by Cloudflare/DDoS protection')
    this.name = 'CloudflareError'
  }
}
