import type { AudioFilter } from '../../core/filters'
import { create } from 'zustand'
import type { AppSettings, HistoryItem, IndexerInfo, IndexerStatus, Release, ResultFilters, TitleInfo, TorrentInfo, UpdateStatus, Watch } from '../../shared/api'
import type { ChipId } from '../../core/filters'
import { groupKey } from '../../core/release'
import { api } from './api'
import { applyTheme } from './theme'
import { resolveLang, setLang, t, translateError, type Lang } from './i18n'

export type Page = 'search' | 'downloads' | 'library' | 'trackers' | 'settings'
export type SortKey = 'relevance' | 'seeders' | 'newest' | 'size-desc' | 'size-asc' | 'name'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
  action?: { label: string; run: () => void }
}

export type GrabState = 'loading' | 'done' | 'error'

interface State {
  page: Page
  setPage: (p: Page) => void
  /** Tracker to expand when the Trackers page opens */
  focusTracker?: string
  openTracker: (id: string) => void
  passChallenge: (id: string, name: string) => Promise<void>

  // search
  query: string
  /** Category chip ids (client-side filter) */
  chips: ChipId[]
  resolutions: string[]
  minSeeds: number
  audio?: AudioFilter
  /** The query the current results are for */
  searchedQuery: string
  sort: SortKey
  setFilters: (patch: Partial<Pick<State, 'chips' | 'resolutions' | 'minSeeds' | 'sort' | 'audio'>>) => void
  /** Movie/series card for the current query */
  title: TitleInfo | null
  searchId?: string
  running: boolean
  releases: Release[]
  /** The title in other languages, searched too */
  alsoSearched: string[]
  statuses: Record<string, IndexerStatus>
  elapsedMs?: number
  setQuery: (q: string) => void
  setChips: (c: ChipId[]) => void
  /** Current filters, as stored with a watch */
  currentFilters: () => ResultFilters
  runSearch: () => Promise<void>
  cancelSearch: () => void

  // grabbing
  grabs: Record<string, GrabState>
  grab: (r: Release) => Promise<void>
  grabTo: (r: Release, path?: string) => Promise<void>
  copyMagnet: (r: Release) => Promise<void>

  // data
  indexers: IndexerInfo[]
  torrents: TorrentInfo[]
  settings?: AppSettings
  loadIndexers: () => Promise<void>
  patchIndexer: (info: IndexerInfo) => void
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  /** Open "where to save?" (when asking is on) and run the download with the chosen folder */
  saveRequest?: { title: string; run: (path?: string) => Promise<void> }
  withSaveLocation: (title: string, run: (path?: string) => Promise<void>) => Promise<void>

  // library
  favoriteKeys: Set<string>
  toggleFavorite: (r: Release) => Promise<void>
  watches: Watch[]
  history: HistoryItem[]
  loadLibrary: () => Promise<void>
  watchCurrent: () => Promise<void>

  lang: Lang
  update?: UpdateStatus
  toasts: Toast[]
  toast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void
}

const grabKey = (r: Release) => `${r.indexerId}|${r.guid}`
let toastSeq = 0

export const useStore = create<State>((set, get) => ({
  page: 'search',
  setPage: (page) => set({ page }),
  openTracker: (id) => set({ page: 'trackers', focusTracker: id }),
  async passChallenge(id, name) {
    get().toast({ kind: 'info', text: t('tr.challenge.opening', { name }) })
    try {
      const res = await api.passChallenge(id)
      get().patchIndexer(res.info)
      get().toast(
        res.ok
          ? { kind: 'success', text: t('tr.challenge.ok', { name }), action: { label: t('tr.challenge.again'), run: () => void get().runSearch() } }
          : { kind: 'error', text: `${name}: ${translateError(res.message ?? '')}` },
      )
    } catch (e) {
      get().toast({ kind: 'error', text: errorText(e) })
    }
  },

  query: '',
  chips: [],
  resolutions: [],
  minSeeds: 0,
  audio: undefined,
  searchedQuery: '',
  sort: 'relevance',
  title: null,
  setFilters: (patch) => set(patch),
  currentFilters: () => {
    const { chips, resolutions, minSeeds, audio } = get()
    return { chips, resolutions, minSeeds, audio }
  },
  running: false,
  releases: [],
  alsoSearched: [],
  statuses: {},
  setQuery: (query) => set({ query }),
  setChips: (chips) => set({ chips }),

  async runSearch() {
    const { query, searchId } = get()
    if (!query.trim()) return
    if (searchId) void api.cancelSearch(searchId)
    const id = crypto.randomUUID()
    set({ running: true, searchedQuery: query.trim(), releases: [], alsoSearched: [], statuses: {}, elapsedMs: undefined, searchId: id, page: 'search', title: null })
    await api.search({ searchId: id, q: query })
    void api.lookupTitle(query).then((title) => get().searchId === id && set({ title }))
  },
  cancelSearch() {
    const { searchId } = get()
    if (searchId) void api.cancelSearch(searchId)
  },

  grabs: {},
  async grab(r) {
    await get().withSaveLocation(r.title, (path) => get().grabTo(r, path))
  },
  async grabTo(r, path) {
    const key = grabKey(r)
    set((s) => ({ grabs: { ...s.grabs, [key]: 'loading' } }))
    try {
      await api.download(r, path)
      set((s) => ({ grabs: { ...s.grabs, [key]: 'done' } }))
      get().toast({ kind: 'success', text: t('dl.added', { title: truncate(r.title, 60) }), action: { label: t('common.show'), run: () => get().setPage('downloads') } })
    } catch (e) {
      set((s) => ({ grabs: { ...s.grabs, [key]: 'error' } }))
      get().toast({ kind: 'error', text: `${r.indexerName}: ${errorText(e)}` })
    }
  },
  async copyMagnet(r) {
    try {
      const magnet = await api.getMagnet(r)
      await navigator.clipboard.writeText(magnet)
      get().toast({ kind: 'info', text: t('dl.magnetCopied') })
    } catch (e) {
      get().toast({ kind: 'error', text: errorText(e) })
    }
  },

  indexers: [],
  torrents: [],
  async loadIndexers() {
    set({ indexers: await api.listIndexers() })
  },
  patchIndexer(info) {
    set((s) => ({ indexers: s.indexers.map((i) => (i.id === info.id ? info : i)) }))
  },
  async saveSettings(patch) {
    applySettings(await api.updateSettings(patch))
  },
  async withSaveLocation(title, run) {
    if (get().settings?.askWhereToSave) set({ saveRequest: { title, run } })
    else await run()
  },

  favoriteKeys: new Set(),
  async toggleFavorite(r) {
    const on = await api.toggleFavorite(r)
    const keys = new Set(get().favoriteKeys)
    if (on) keys.add(groupKey(r))
    else keys.delete(groupKey(r))
    set({ favoriteKeys: keys })
  },
  watches: [],
  history: [],
  async loadLibrary() {
    const [keys, watches, history] = await Promise.all([api.favoriteKeys(), api.watches(), api.history()])
    set({ favoriteKeys: new Set(keys), watches, history })
  },
  async watchCurrent() {
    const { query, title } = get()
    if (!query.trim()) return
    await api.addWatch(query.trim(), get().currentFilters(), title ? { title: `${title.name}${title.year ? ` (${title.year})` : ''}`, poster: title.poster } : undefined)
    get().toast({ kind: 'success', text: t('search.watchAdded', { query: query.trim() }), action: { label: t('common.show'), run: () => get().setPage('library') } })
    await get().loadLibrary()
  },

  lang: 'en',

  toasts: [],
  toast(t) {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }))
    setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 7000 : 4000)
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

export const grabStateOf = (grabs: Record<string, GrabState>, r: Release) => grabs[grabKey(r)]

// Electron wraps errors thrown in the main process: "Error invoking remote method 'x': Error: msg"
export const errorText = (e: unknown) => translateError(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''))

function applySettings(settings: AppSettings) {
  const lang = resolveLang(settings.language)
  setLang(lang)
  applyTheme(settings.theme, settings.accent)
  useStore.setState({ settings, lang })
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// --- wire backend events into the store ---

api.onSearchEvent((e) => {
  const s = useStore.getState()
  if (e.searchId !== s.searchId) return
  if (e.type === 'results') useStore.setState({ releases: [...s.releases, ...e.releases] })
  else if (e.type === 'variants') useStore.setState({ alsoSearched: e.names })
  else if (e.type === 'status') useStore.setState({ statuses: { ...s.statuses, [e.status.indexerId]: e.status } })
  else if (e.type === 'done') {
    useStore.setState({ running: false, elapsedMs: e.elapsedMs })
    void s.loadIndexers()
    void s.loadLibrary()
  }
})

api.onTorrents((torrents) => useStore.setState({ torrents }))
api.onAskSave(({ magnet, name }) =>
  void useStore.getState().withSaveLocation(name, async (path) => {
    await api.addMagnet(magnet, path)
  }),
)
api.onIndexersChanged(() => void useStore.getState().loadIndexers())
api.onUpdateStatus((update) => useStore.setState({ update }))
api.onNavigate((page) => useStore.setState({ page }))
api.onLibraryChanged(() => void useStore.getState().loadLibrary())
void useStore.getState().loadLibrary()
void api.updateStatus().then((update) => useStore.setState({ update }))

void api.getSettings().then(applySettings)
void api.listTorrents().then((torrents) => useStore.setState({ torrents }))
void useStore.getState().loadIndexers()
