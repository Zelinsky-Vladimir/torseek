import type { CategoryMap } from './categories'
import type { SettingsField } from './cardigann/types'
import type { Release } from './release'

// What the app needs from a tracker, whether it's driven by a Cardigann YAML
// definition or written by hand in TypeScript (sites the YAML format can't express).

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
  /** undefined when the site needs no account */
  readonly loginMethod: string | undefined
  /** Page to open for a manual sign-in */
  readonly loginPageUrl: string
  /** Whether login success can be detected automatically (otherwise the user closes the window) */
  readonly canTestLogin: boolean

  updateSettings(settings: IndexerSettings): void
  search(query: SearchQuery, signal?: AbortSignal): Promise<Release[]>
  resolveDownload(release: Pick<Release, 'link' | 'magnet' | 'title'>, signal?: AbortSignal): Promise<DownloadTarget>

  login(signal?: AbortSignal): Promise<void>
  testLogin(signal?: AbortSignal): Promise<boolean>
  logout(): Promise<void>
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
