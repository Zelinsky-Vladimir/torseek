import { useEffect, useMemo, useState } from 'react'
import { BellRing, ChevronRight, Clock, History, RefreshCw, Search, Star, Trash2, X } from 'lucide-react'
import { groupReleases, type ReleaseGroup } from '../../../core/release'
import type { FavoriteItem, Watch, WatchHit } from '../../../shared/api'
import { api } from '../api'
import { CATEGORY_CHIPS } from '../categories'
import { ResultHeader, ResultRow } from '../components/ResultRow'
import { cx, formatAge } from '../format'
import { t, tn } from '../i18n'
import { errorText, useStore } from '../store'
import { Button, EmptyState, IconButton } from '../ui'

type Tab = 'watchlist' | 'favorites' | 'history'

const groupsOf = (items: { release: FavoriteItem['release'] }[]): ReleaseGroup[] => [...groupReleases(items.map((i) => i.release)).values()]

export function LibraryPage() {
  const watches = useStore((s) => s.watches)
  const [tab, setTab] = useState<Tab>('watchlist')
  const newTotal = watches.reduce((s, w) => s + w.newCount, 0)

  const tabs: { id: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'watchlist', label: t('lib.watchlist'), icon: <BellRing className="size-3.5" />, badge: newTotal || undefined },
    { id: 'favorites', label: t('lib.favorites'), icon: <Star className="size-3.5" /> },
    { id: 'history', label: t('lib.history'), icon: <History className="size-3.5" /> },
  ]

  return (
    <div className="flex h-full flex-col">
      <div className="drag flex items-center gap-4 border-b border-line/70 px-6 pb-3 pt-3.5">
        <h1 className="text-[17px] font-semibold">{t('nav.library')}</h1>
        <div className="no-drag flex items-center gap-1 rounded-lg bg-panel p-0.5 text-[12.5px]">
          {tabs.map((x) => (
            <button
              key={x.id}
              onClick={() => setTab(x.id)}
              className={cx('flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1', tab === x.id ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}
            >
              {x.icon}
              {x.label}
              {x.badge && <span className="rounded-full bg-accent-2 px-1.5 text-[10.5px] font-semibold leading-4 text-white">{x.badge}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {tab === 'watchlist' && <WatchList />}
        {tab === 'favorites' && <Favorites />}
        {tab === 'history' && <HistoryList />}
      </div>
    </div>
  )
}

function WatchList() {
  const watches = useStore((s) => s.watches)
  const [open, setOpen] = useState<number | null>(null)
  if (!watches.length) {
    return (
      <EmptyState icon={<BellRing className="size-6" />} title={t('lib.watchEmptyTitle')}>
        {t('lib.watchEmptyText')}
      </EmptyState>
    )
  }
  return (
    <div className="space-y-1">
      {watches.map((w) => (
        <WatchRow key={w.id} w={w} open={open === w.id} onToggle={() => setOpen(open === w.id ? null : w.id)} />
      ))}
    </div>
  )
}

function filterSummary(w: Watch): string {
  const parts: string[] = []
  for (const id of w.filters.chips ?? []) {
    const chip = CATEGORY_CHIPS.find((c) => c.id === id)
    if (chip) parts.push(t(chip.label))
  }
  for (const r of w.filters.resolutions ?? []) parts.push(r === '2160p' ? '4K' : r)
  if (w.filters.minSeeds) parts.push(`${t('search.minSeeds')} ${w.filters.minSeeds}+`)
  return parts.join(' · ')
}

function WatchRow({ w, open, onToggle }: { w: Watch; open: boolean; onToggle: () => void }) {
  const { loadLibrary, toast } = useStore()
  const [hits, setHits] = useState<WatchHit[] | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (open) void api.watchHits(w.id).then(setHits)
  }, [open, w.checkedAt, w.newCount])

  const groups = useMemo(() => groupsOf(hits ?? []), [hits])
  const unseen = new Set((hits ?? []).filter((h) => !h.seen).map((h) => h.key))
  const summary = filterSummary(w)

  return (
    <div className={cx('rounded-xl', open && 'bg-panel')}>
      <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-panel">
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onToggle}>
          {w.poster ? (
            <img src={w.poster} alt="" className="h-12 w-8 shrink-0 rounded object-cover" />
          ) : (
            <div className="flex h-12 w-8 shrink-0 items-center justify-center rounded bg-panel-2 text-faint">
              <Search className="size-3.5" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13.5px] font-medium">{w.title ?? w.query}</span>
              {w.newCount > 0 && <span className="rounded-full bg-accent-2 px-1.5 text-[11px] font-semibold leading-[18px] text-white">{tn('lib.newHits', w.newCount)}</span>}
            </div>
            <div className="mt-0.5 flex items-center gap-2 truncate text-[12px] text-muted">
              {w.title && <span className="truncate">“{w.query}”</span>}
              {summary && <span className="text-faint">{summary}</span>}
              <span className="flex items-center gap-1 text-faint">
                <Clock className="size-3" />
                {w.checkedAt ? t('lib.checked', { age: formatAge(new Date(w.checkedAt).toISOString()) }) : t('lib.neverChecked')}
              </span>
            </div>
          </div>
          <ChevronRight className={cx('size-4 text-faint transition-transform', open && 'rotate-90')} />
        </button>
        <IconButton
          label={t('lib.checkNow')}
          disabled={checking}
          onClick={async () => {
            setChecking(true)
            try {
              await api.checkWatch(w.id)
              await loadLibrary()
            } catch (e) {
              toast({ kind: 'error', text: errorText(e) })
            } finally {
              setChecking(false)
            }
          }}
        >
          <RefreshCw className={cx('size-4', checking && 'animate-spin')} />
        </IconButton>
        <IconButton
          label={t('lib.stopWatching')}
          className="hover:!text-bad"
          onClick={async () => {
            await api.removeWatch(w.id)
            await loadLibrary()
          }}
        >
          <Trash2 className="size-4" />
        </IconButton>
      </div>
      {open && (
        <div className="px-3 pb-3">
          {!groups.length ? (
            <p className="px-2 py-3 text-[12.5px] text-muted">{t('lib.noNewYet')}</p>
          ) : (
            <>
              <div className="flex justify-end px-2 pb-1">
                {w.newCount > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await api.markWatchSeen(w.id)
                      await loadLibrary()
                    }}
                  >
                    {t('lib.markSeen')}
                  </Button>
                )}
              </div>
              <ResultHeader />
              {groups.map((g) => (
                <ResultRow key={g.key} group={g} highlight={unseen.has(g.key)} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Favorites() {
  const favoriteKeys = useStore((s) => s.favoriteKeys)
  const [items, setItems] = useState<FavoriteItem[] | null>(null)
  useEffect(() => void api.favorites().then(setItems), [favoriteKeys])
  // Keep un-starred rows visible until the tab reloads, so a misclick can be undone
  const groups = useMemo(() => groupsOf(items ?? []), [items])
  if (!items) return null
  if (!items.length) {
    return (
      <EmptyState icon={<Star className="size-6" />} title={t('lib.favEmptyTitle')}>
        {t('lib.favEmptyText')}
      </EmptyState>
    )
  }
  return (
    <div className="py-1">
      <ResultHeader />
      {groups.map((g) => (
        <ResultRow key={g.key} group={g} />
      ))}
    </div>
  )
}

function HistoryList() {
  const { history, loadLibrary, setQuery, runSearch } = useStore()
  if (!history.length) return <EmptyState icon={<History className="size-6" />} title={t('lib.histEmptyTitle')} />
  return (
    <div>
      <div className="flex justify-end px-2 py-1">
        <Button
          size="sm"
          variant="ghost"
          icon={<Trash2 className="size-3.5" />}
          onClick={async () => {
            await api.clearHistory()
            await loadLibrary()
          }}
        >
          {t('lib.clearHistory')}
        </Button>
      </div>
      {history.map((h) => (
        <div key={h.query} className="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-panel">
          <button
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            onClick={() => {
              setQuery(h.query)
              void runSearch()
            }}
          >
            <Search className="size-4 shrink-0 text-faint" />
            <span className="truncate text-[13.5px] selectable">{h.query}</span>
            <span className="text-[12px] tabular-nums text-faint">{tn('search.results', h.results)}</span>
          </button>
          <span className="text-[12px] tabular-nums text-faint">{formatAge(new Date(h.searchedAt).toISOString())}</span>
          <IconButton
            label={t('common.clear')}
            className="opacity-0 group-hover:opacity-100"
            onClick={async () => {
              await api.removeHistory(h.query)
              await loadLibrary()
            }}
          >
            <X className="size-4" />
          </IconButton>
        </div>
      ))}
    </div>
  )
}
