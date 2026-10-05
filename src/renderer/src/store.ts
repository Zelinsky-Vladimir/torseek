import { create } from 'zustand'
import type { AppSettings, IndexerInfo, IndexerStatus, Release, TorrentInfo } from '../../shared/api'
import { api } from './api'

export type Page = 'search' | 'downloads' | 'trackers' | 'settings'

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
  chips: string[]
  searchId?: string
  running: boolean
  releases: Release[]
  statuses: Record<string, IndexerStatus>
  elapsedMs?: number
  setQuery: (q: string) => void
  setChips: (c: string[]) => void
  runSearch: () => Promise<void>
  cancelSearch: () => void

  // grabbing
  grabs: Record<string, GrabState>
  grab: (r: Release) => Promise<void>
  copyMagnet: (r: Release) => Promise<void>

  // data
  indexers: IndexerInfo[]
  torrents: TorrentInfo[]
  settings?: AppSettings
  loadIndexers: () => Promise<void>
  patchIndexer: (info: IndexerInfo) => void
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>

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
    get().toast({ kind: 'info', text: `Opening ${name}. Complete the check if the site shows one` })
    try {
      const res = await api.passChallenge(id)
      get().patchIndexer(res.info)
      get().toast(
        res.ok
          ? { kind: 'success', text: `${name} is reachable now`, action: { label: 'Search again', run: () => void get().runSearch() } }
          : { kind: 'error', text: `${name}: ${res.message}` },
      )
    } catch (e) {
      get().toast({ kind: 'error', text: errorText(e) })
    }
  },

  query: '',
  chips: [],
  running: false,
  releases: [],
  statuses: {},
  setQuery: (query) => set({ query }),
  setChips: (chips) => set({ chips }),

  async runSearch() {
    const { query, searchId } = get()
    if (!query.trim()) return
    if (searchId) void api.cancelSearch(searchId)
    const id = crypto.randomUUID()
    set({ running: true, releases: [], statuses: {}, elapsedMs: undefined, searchId: id, page: 'search' })
    await api.search({ searchId: id, q: query })
    rememberQuery(query)
  },
  cancelSearch() {
    const { searchId } = get()
    if (searchId) void api.cancelSearch(searchId)
  },

  grabs: {},
  async grab(r) {
    const key = grabKey(r)
    set((s) => ({ grabs: { ...s.grabs, [key]: 'loading' } }))
    try {
      await api.download(r)
      set((s) => ({ grabs: { ...s.grabs, [key]: 'done' } }))
      get().toast({ kind: 'success', text: `Added “${truncate(r.title, 60)}”`, action: { label: 'Show', run: () => get().setPage('downloads') } })
    } catch (e) {
      set((s) => ({ grabs: { ...s.grabs, [key]: 'error' } }))
      get().toast({ kind: 'error', text: `${r.indexerName}: ${errorText(e)}` })
    }
  },
  async copyMagnet(r) {
    try {
      const magnet = await api.getMagnet(r)
      await navigator.clipboard.writeText(magnet)
      get().toast({ kind: 'info', text: 'Magnet link copied' })
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
    set({ settings: await api.updateSettings(patch) })
  },

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
export const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// --- wire backend events into the store ---

api.onSearchEvent((e) => {
  const s = useStore.getState()
  if (e.searchId !== s.searchId) return
  if (e.type === 'results') useStore.setState({ releases: [...s.releases, ...e.releases] })
  else if (e.type === 'status') useStore.setState({ statuses: { ...s.statuses, [e.status.indexerId]: e.status } })
  else if (e.type === 'done') {
    useStore.setState({ running: false, elapsedMs: e.elapsedMs })
    void s.loadIndexers()
  }
})

api.onTorrents((torrents) => useStore.setState({ torrents }))
api.onIndexersChanged(() => void useStore.getState().loadIndexers())

void api.getSettings().then((settings) => useStore.setState({ settings }))
void api.listTorrents().then((torrents) => useStore.setState({ torrents }))
void useStore.getState().loadIndexers()

// --- recent searches (per-device convenience) ---

const RECENT_KEY = 'torseek.recent'

export function recentQueries(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
  } catch {
    return []
  }
}

function rememberQuery(q: string) {
  try {
    const list = [q.trim(), ...recentQueries().filter((x) => x.toLowerCase() !== q.trim().toLowerCase())].slice(0, 8)
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* storage unavailable */
  }
}
