import { CardigannIndexer } from '../core/cardigann/indexer'
import { loadDefinitions } from '../core/cardigann/loader'
import type { HttpClient } from '../core/http'
import type { Indexer, IndexerSettings, SearchQuery } from '../core/indexer'
import { createNativeIndexers } from '../core/native'
import { searchAll, type IndexerStatus, type SearchAllOptions } from '../core/search'
import type { ChallengeResult, IndexerInfo } from '../shared/api'
import type { JsonStore } from './store'

// Trackers that answered both an English and a Russian test query from a plain
// connection (no Cloudflare) when this list was made; adult-only sites excluded.
const DEFAULT_ENABLED = new Set([
  '52bt', 'acgrip', 'animetosho-xyz', 'bigfangroup', 'byrutor', 'dmhy', 'filemood', 'internetarchive',
  'limetorrents', 'mactorrentsdownload', 'magnetdownload', 'magnetz', 'megapeer', 'noname-club', 'nyaasi',
  'opensharing', 'pandacd', 'pctorrent', 'rintornet', 'rutor', 'rutracker-ru', 'thepiratebay', 'therarbg',
  'torrent-pirat', 'torrent9', 'torrentdownload', 'torrentdownloads', 'torrentgalaxyclone', 'torrentkitty',
  'world-torrent', 'yts', 'zamundalife',
  // hand-written public ports
  'knaben', 'torrentscsv', 'subsplease', 'anilibria', 'audiobookbay',
])

export interface IndexerPrefs {
  enabled: boolean
  values: IndexerSettings
}

export interface IndexerStoreShape {
  indexers: Record<string, IndexerPrefs>
}

type Health = NonNullable<IndexerInfo['health']>

/** Encrypts secrets at rest (Electron safeStorage); identity when unavailable. */
export interface Secrets {
  seal(plain: string): string
  open(sealed: string): string
}

// Optional API keys some public sites offer; kept out of the JSON file in plain text
const SECRET_FIELDS = new Set(['password', 'cookie', 'apikey', 'passkey', 'rsskey', 'token'])
const isSecret = (name: string, type?: string) => type === 'password' || SECRET_FIELDS.has(name.toLowerCase())

export type WindowText = (key: 'challenge', name: string) => string

const ENGLISH_TEXT: WindowText = (_key, name) => `${name}: complete the check if one is shown — this window closes by itself`

/** Opens a tracker site for the user; resolves 'done' when isDone() turned true. */
export type SiteOpener = (opts: { url: string; title: string; isDone?: () => Promise<boolean> }) => Promise<'done' | 'closed'>

export class IndexerManager {
  private indexers = new Map<string, Indexer>()
  private unsupported = new Map<string, string>()
  private health = new Map<string, Health>()

  constructor(
    private readonly dirs: string[],
    private readonly http: HttpClient,
    private readonly store: JsonStore<IndexerStoreShape>,
    private readonly openSite: SiteOpener,
    private readonly log: (msg: string) => void = () => {},
    private readonly secrets: Secrets = { seal: (s) => s, open: (s) => s },
    private readonly text: WindowText = ENGLISH_TEXT,
  ) {}

  private secretKeys(id: string): Set<string> {
    const fields = this.indexers.get(id)?.settingsFields ?? []
    return new Set(fields.filter((f) => isSecret(f.name, f.type)).map((f) => f.name))
  }

  private mapSecrets(id: string, values: IndexerSettings, fn: (s: string) => string): IndexerSettings {
    const keys = this.secretKeys(id)
    return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, keys.has(k) && typeof v === 'string' && v ? fn(v) : v]))
  }

  async load() {
    const loaded = await loadDefinitions(this.dirs, (file, err) => this.log(`definition ${file}: ${err.message}`))
    this.indexers.clear()
    this.unsupported.clear()
    const ixLog = (level: string, msg: string) => level !== 'debug' && this.log(msg)
    // Only trackers that need no account (old private definitions may linger in the user folder)
    for (const { definition, unsupported } of loaded.filter((l) => l.definition.type === 'public')) {
      this.indexers.set(definition.id, new CardigannIndexer(definition, { http: this.http, settings: this.prefs(definition.id).values, log: ixLog }))
      if (unsupported) this.unsupported.set(definition.id, unsupported)
    }
    // Hand-written indexers replace YAML ones with the same id
    for (const ix of createNativeIndexers({ http: this.http, log: ixLog })) {
      ix.updateSettings(this.prefs(ix.id).values)
      this.indexers.set(ix.id, ix)
    }
    this.log(`loaded ${this.indexers.size} trackers`)
  }

  private prefs(id: string): IndexerPrefs {
    const stored = this.store.get().indexers[id]
    if (!stored) return { enabled: DEFAULT_ENABLED.has(id), values: {} }
    return { enabled: stored.enabled, values: this.mapSecrets(id, stored.values, (s) => this.secrets.open(s)) }
  }

  private setPrefs(id: string, patch: Partial<IndexerPrefs>) {
    const next = { ...this.prefs(id), ...patch }
    this.store.update((d) => {
      d.indexers[id] = { ...next, values: this.mapSecrets(id, next.values, (s) => this.secrets.seal(s)) }
    })
  }

  get(id: string): Indexer {
    const ix = this.indexers.get(id)
    if (!ix) throw new Error(`Unknown tracker ${id}`)
    return ix
  }

  info(id: string): IndexerInfo {
    const ix = this.get(id)
    const prefs = this.prefs(id)
    const unsupported = this.unsupported.get(id)
    return {
      ...ix.meta,
      siteLink: ix.siteLink,
      enabled: prefs.enabled && !unsupported,
      unsupported,
      categories: ix.categories.topLevel(),
      settings: ix.settingsFields,
      values: prefs.values,
      health: this.health.get(id),
    }
  }

  list(): IndexerInfo[] {
    return [...this.indexers.keys()].map((id) => this.info(id)).sort((a, b) => a.name.localeCompare(b.name))
  }

  setEnabled(id: string, enabled: boolean): IndexerInfo {
    this.setPrefs(id, { enabled })
    return this.info(id)
  }

  updateSettings(id: string, values: IndexerSettings): IndexerInfo {
    this.setPrefs(id, { values })
    this.get(id).updateSettings(values)
    return this.info(id)
  }

  enabledIndexers(): Indexer[] {
    return this.list()
      .filter((i) => i.enabled)
      .map((i) => this.get(i.id))
  }

  recordStatus(s: IndexerStatus) {
    if (!['done', 'error', 'blocked', 'timeout'].includes(s.state)) return
    this.health.set(s.indexerId, { state: s.state, error: s.error, count: s.count, at: Date.now() })
  }

  async search(query: SearchQuery, opts: SearchAllOptions, indexers = this.enabledIndexers()) {
    await searchAll(indexers, query, {
      ...opts,
      onStatus: (s) => {
        this.recordStatus(s)
        opts.onStatus(s)
      },
    })
  }

  /** Empty-keyword search, which most definitions turn into "latest torrents". */
  async test(id: string): Promise<IndexerInfo> {
    await this.search({ q: '' }, { onResults: () => {}, onStatus: () => {}, timeoutMs: 30_000 }, [this.get(id)])
    return this.info(id)
  }

  /** Open the site so a Cloudflare / DDoS-Guard check can complete in a real browser window. */
  async passChallenge(id: string): Promise<ChallengeResult> {
    const ix = this.get(id)
    const check = () => ix.checkAccess(AbortSignal.timeout(15_000))
    const result = await this.openSite({ url: ix.siteLink, title: this.text('challenge', ix.name), isDone: check })
    const ok = result === 'done' || (await check().catch(() => false))
    if (ok) this.health.delete(id)
    return { ok, message: ok ? undefined : 'The site still shows its protection page', info: this.info(id) }
  }
}
