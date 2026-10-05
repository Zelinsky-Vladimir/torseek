import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, Check, ChevronDown, CircleAlert, ExternalLink, Loader2, Magnet, Search, ShieldAlert, Sparkles, X } from 'lucide-react'
import { groupReleases, type ReleaseGroup } from '../../../core/release'
import type { IndexerStatus } from '../../../shared/api'
import { CATEGORY_CHIPS, categoryLabel, isAdult } from '../categories'
import { cx, formatAge, formatBytes, formatCount } from '../format'
import { grabStateOf, recentQueries, useStore } from '../store'
import { Badge, Chip, EmptyState, IconButton } from '../ui'

type SortKey = 'seeders' | 'newest' | 'size-desc' | 'size-asc' | 'name'
const SORTS: { id: SortKey; label: string }[] = [
  { id: 'seeders', label: 'Most seeded' },
  { id: 'newest', label: 'Newest' },
  { id: 'size-desc', label: 'Largest' },
  { id: 'size-asc', label: 'Smallest' },
  { id: 'name', label: 'Name' },
]
const RESOLUTIONS = ['2160p', '1080p', '720p', '480p'] as const
const PAGE = 150

export function SearchPage() {
  const { query, setQuery, runSearch, cancelSearch, running, releases, statuses, chips, setChips, settings, indexers } = useStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const [sort, setSort] = useState<SortKey>('seeders')
  const [resolutions, setResolutions] = useState<string[]>([])
  const [minSeeds, setMinSeeds] = useState(0)
  const [limit, setLimit] = useState(PAGE)
  const hasSearched = Object.keys(statuses).length > 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'f')) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => setLimit(PAGE), [releases.length === 0, chips, resolutions, minSeeds, sort])

  const groups = useMemo(() => [...groupReleases(releases).values()], [releases])

  const visibleChips = CATEGORY_CHIPS.filter((c) => !c.adult || settings?.showAdult)
  const chipCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const g of groups) for (const c of visibleChips) if (g.primary.categories.some(c.match)) counts[c.id] = (counts[c.id] ?? 0) + 1
    return counts
  }, [groups, settings?.showAdult])

  const filtered = useMemo(() => {
    const chipDefs = CATEGORY_CHIPS.filter((c) => chips.includes(c.id))
    const list = groups.filter((g) => {
      const r = g.primary
      if (!settings?.showAdult && isAdult(r.categories)) return false
      if (chipDefs.length && !chipDefs.some((c) => r.categories.some(c.match))) return false
      if (resolutions.length && !resolutions.includes(g.quality.resolution ?? '')) return false
      if (minSeeds && (r.seeders ?? 0) < minSeeds) return false
      return true
    })
    const by: Record<SortKey, (a: ReleaseGroup, b: ReleaseGroup) => number> = {
      seeders: (a, b) => (b.primary.seeders ?? -1) - (a.primary.seeders ?? -1),
      newest: (a, b) => (b.primary.publishDate ?? '').localeCompare(a.primary.publishDate ?? ''),
      'size-desc': (a, b) => (b.primary.size ?? 0) - (a.primary.size ?? 0),
      'size-asc': (a, b) => (a.primary.size ?? Infinity) - (b.primary.size ?? Infinity),
      name: (a, b) => a.primary.title.localeCompare(b.primary.title),
    }
    return list.sort(by[sort])
  }, [groups, chips, resolutions, minSeeds, sort, settings?.showAdult])

  const enabledCount = indexers.filter((i) => i.enabled).length

  return (
    <div className="flex h-full flex-col">
      {/* search header */}
      <div className="drag border-b border-line/70 px-6 pb-3 pt-3">
        <form
          className="no-drag relative mr-[140px] max-w-3xl"
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch()
          }}
        >
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-faint" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (running ? cancelSearch() : setQuery(''))}
            placeholder={`Search ${enabledCount} trackers…`}
            className="selectable h-11 w-full rounded-xl border border-line bg-panel pl-11 pr-28 text-[15px] outline-none transition-colors placeholder:text-faint focus:border-accent/70 focus:bg-panel-2"
          />
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {query && (
              <IconButton type="button" label="Clear" onClick={() => setQuery('')} className="size-7">
                <X className="size-4" />
              </IconButton>
            )}
            <kbd className="rounded border border-line px-1.5 py-0.5 text-[11px] text-faint">Ctrl K</kbd>
          </div>
        </form>

        <div className="no-drag mt-3 flex flex-wrap items-center gap-1.5">
          <Chip active={chips.length === 0} onClick={() => setChips([])} count={hasSearched ? groups.length : undefined}>
            All
          </Chip>
          {visibleChips.map((c) => (
            <Chip
              key={c.id}
              active={chips.includes(c.id)}
              count={hasSearched ? (chipCounts[c.id] ?? 0) : undefined}
              onClick={() => setChips(chips.includes(c.id) ? chips.filter((x) => x !== c.id) : [...chips, c.id])}
            >
              {c.label}
            </Chip>
          ))}
        </div>
      </div>

      {hasSearched && <TrackerProgress statuses={statuses} running={running} onCancel={cancelSearch} />}

      {hasSearched && (
        <div className="flex items-center gap-4 border-b border-line/70 px-6 py-2 text-[12.5px] text-muted">
          <span className="tabular-nums">
            <span className="font-semibold text-fg">{filtered.length}</span> results
            {filtered.length !== groups.length && <span className="text-faint"> of {groups.length}</span>}
          </span>
          <div className="h-4 w-px bg-line" />
          <div className="flex items-center gap-1">
            {RESOLUTIONS.map((r) => (
              <button
                key={r}
                onClick={() => setResolutions(resolutions.includes(r) ? resolutions.filter((x) => x !== r) : [...resolutions, r])}
                className={cx('rounded-md px-2 py-0.5 font-medium transition-colors', resolutions.includes(r) ? 'bg-accent/15 text-fg' : 'hover:text-fg')}
              >
                {r === '2160p' ? '4K' : r === '480p' ? 'SD' : r}
              </button>
            ))}
          </div>
          <div className="h-4 w-px bg-line" />
          <label className="flex items-center gap-2">
            Min seeds
            <select value={minSeeds} onChange={(e) => setMinSeeds(Number(e.target.value))} className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-fg outline-none">
              {[0, 1, 5, 20, 100].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'Any' : `${n}+`}
                </option>
              ))}
            </select>
          </label>
          <div className="ml-auto flex items-center gap-2">
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-fg outline-none">
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!hasSearched ? (
          <Welcome enabledCount={enabledCount} onPick={(q) => {
            setQuery(q)
            setTimeout(() => void useStore.getState().runSearch())
          }} />
        ) : filtered.length === 0 ? (
          running ? (
            <ResultSkeleton />
          ) : (
            <EmptyState icon={<Search className="size-6" />} title="Nothing found">
              Try a shorter query, the original title, or enable more trackers.
            </EmptyState>
          )
        ) : (
          <div className="px-3 py-2">
            <div className="grid grid-cols-[minmax(0,1fr)_88px_96px_56px_112px] gap-x-3 px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
              <div>Name</div>
              <div className="text-right">Size</div>
              <div className="text-right">Seeds / Peers</div>
              <div className="text-right">Age</div>
              <div />
            </div>
            {filtered.slice(0, limit).map((g) => (
              <ResultRow key={g.key} group={g} />
            ))}
            {filtered.length > limit && (
              <div className="flex justify-center py-4">
                <button onClick={() => setLimit(limit + PAGE)} className="rounded-lg border border-line px-4 py-2 text-[13px] text-muted hover:bg-hover hover:text-fg">
                  Show {Math.min(PAGE, filtered.length - limit)} more
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ResultRow({ group }: { group: ReleaseGroup }) {
  const r = group.primary
  const { grab, copyMagnet, grabs } = useStore()
  const state = grabStateOf(grabs, r)
  const q = group.quality
  const cat = categoryLabel(r.categories)
  const others = group.sources.filter((s) => s !== r)
  const freeleech = r.downloadVolumeFactor === 0

  return (
    <div className="group grid grid-cols-[minmax(0,1fr)_88px_96px_56px_112px] items-center gap-x-3 rounded-lg px-3 py-2 hover:bg-panel">
      <div className="min-w-0">
        <div className="truncate text-[13.5px] font-medium leading-5 text-fg selectable" title={r.title}>
          {r.title}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 overflow-hidden text-[12px] text-muted">
          {q.resolution && <Badge tone={q.resolution === '2160p' ? 'accent' : 'neutral'}>{q.resolution === '2160p' ? '4K' : q.resolution}</Badge>}
          {q.hdr && <Badge tone="warn">{q.hdr}</Badge>}
          {q.source && <Badge tone={q.source === 'CAM' ? 'bad' : 'neutral'}>{q.source}</Badge>}
          {q.codec && <Badge>{q.codec}</Badge>}
          {freeleech && <Badge tone="good">FREE</Badge>}
          <span className="truncate">
            <span className="text-fg/80">{r.indexerName}</span>
            {others.length > 0 && (
              <span className="text-faint" title={others.map((o) => o.indexerName).join(', ')}>
                {' '}+{others.length} more
              </span>
            )}
            {cat && <span className="text-faint"> · {cat}</span>}
          </span>
        </div>
      </div>
      <div className="text-right text-[13px] tabular-nums text-muted">{formatBytes(r.size)}</div>
      <div className="text-right text-[13px] tabular-nums">
        <span className={cx('font-semibold', (r.seeders ?? 0) > 0 ? 'text-good' : 'text-faint')}>{formatCount(r.seeders)}</span>
        <span className="text-faint"> / {formatCount(r.leechers)}</span>
      </div>
      <div className="text-right text-[13px] tabular-nums text-muted" title={r.publishDate ? new Date(r.publishDate).toLocaleString() : undefined}>
        {formatAge(r.publishDate)}
      </div>
      <div className="flex items-center justify-end gap-0.5">
        {r.details && (
          <IconButton label="Open tracker page" onClick={() => void window.open(r.details, '_blank')} className="opacity-0 group-hover:opacity-100">
            <ExternalLink className="size-4" />
          </IconButton>
        )}
        <IconButton label="Copy magnet link" onClick={() => void copyMagnet(r)} className="opacity-0 group-hover:opacity-100">
          <Magnet className="size-4" />
        </IconButton>
        <button
          onClick={() => void grab(r)}
          disabled={state === 'loading'}
          title="Download"
          className={cx(
            'inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
            state === 'done' ? 'bg-good/15 text-good' : state === 'error' ? 'bg-bad/15 text-bad hover:bg-bad/25' : 'bg-accent/15 text-accent hover:bg-accent-2 hover:text-white',
          )}
        >
          {state === 'loading' ? <Loader2 className="size-4 animate-spin" /> : state === 'done' ? <Check className="size-4" /> : state === 'error' ? <CircleAlert className="size-4" /> : <ArrowDownToLine className="size-4" />}
        </button>
      </div>
    </div>
  )
}

const STATE_STYLE: Record<IndexerStatus['state'], string> = {
  queued: 'text-faint',
  running: 'text-muted',
  done: 'text-fg',
  error: 'text-bad',
  blocked: 'text-warn',
  auth: 'text-warn',
  timeout: 'text-warn',
  cancelled: 'text-faint',
}

function TrackerProgress({ statuses, running, onCancel }: { statuses: Record<string, IndexerStatus>; running: boolean; onCancel: () => void }) {
  const [open, setOpen] = useState(false)
  const { passChallenge, openTracker } = useStore()
  const list = Object.values(statuses)
  const finished = list.filter((s) => !['queued', 'running'].includes(s.state)).length
  const withResults = list.filter((s) => s.state === 'done' && (s.count ?? 0) > 0).length
  const problems = list.filter((s) => ['error', 'blocked', 'auth', 'timeout'].includes(s.state)).length
  const sorted = [...list].sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || a.indexerName.localeCompare(b.indexerName))

  return (
    <div className="border-b border-line/70 px-6 py-2">
      <div className="flex items-center gap-3 text-[12.5px]">
        <div className="relative h-1 w-40 overflow-hidden rounded-full bg-line">
          <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-300" style={{ width: `${(finished / Math.max(1, list.length)) * 100}%` }} />
          {running && <div className="animate-shimmer absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent" />}
        </div>
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-muted hover:text-fg">
          {running ? (
            <span>
              Searching <span className="tabular-nums text-fg">{finished}</span>/{list.length} trackers
            </span>
          ) : (
            <span>
              Results from <span className="tabular-nums text-fg">{withResults}</span> of {list.length} trackers
            </span>
          )}
          {problems > 0 && (
            <span className="flex items-center gap-1 text-warn">
              <ShieldAlert className="size-3.5" />
              {problems} unavailable
            </span>
          )}
          <ChevronDown className={cx('size-3.5 transition-transform', open && 'rotate-180')} />
        </button>
        {running && (
          <button onClick={onCancel} className="ml-auto text-muted hover:text-fg">
            Stop
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap gap-1.5 pb-1">
          {sorted.map((s) => {
            const actionable = s.state === 'blocked' || s.state === 'auth'
            return (
              <button
                key={s.indexerId}
                disabled={!actionable}
                onClick={() => (s.state === 'blocked' ? void passChallenge(s.indexerId, s.indexerName) : openTracker(s.indexerId))}
                title={
                  s.state === 'blocked'
                    ? 'Protected by Cloudflare / DDoS-Guard. Click to open the site and pass the check'
                    : s.state === 'auth'
                      ? `${s.error ?? 'Sign-in required'}. Click to open the tracker's account settings`
                      : (s.error ?? (s.state === 'timeout' ? 'Took too long' : undefined))
                }
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-0.5 text-[12px]',
                  STATE_STYLE[s.state],
                  actionable && 'border-warn/40 hover:bg-warn/10',
                )}
              >
                {s.state === 'running' && <Loader2 className="size-3 animate-spin" />}
                {s.indexerName}
                <span className="tabular-nums text-faint">
                  {s.state === 'done' ? s.count : s.state === 'running' || s.state === 'queued' ? '' : s.state === 'auth' ? 'sign in' : s.state === 'blocked' ? 'unlock' : s.state}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ResultSkeleton() {
  return (
    <div className="space-y-1 px-6 py-4">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 py-2.5" style={{ opacity: 1 - i * 0.1 }}>
          <div className="flex-1 space-y-2">
            <div className="h-3.5 rounded bg-panel-2" style={{ width: `${70 - (i % 3) * 15}%` }} />
            <div className="h-2.5 w-1/4 rounded bg-panel" />
          </div>
          <div className="h-3 w-14 rounded bg-panel" />
          <div className="h-3 w-16 rounded bg-panel" />
          <div className="size-8 rounded-lg bg-panel" />
        </div>
      ))}
    </div>
  )
}

function Welcome({ enabledCount, onPick }: { enabledCount: number; onPick: (q: string) => void }) {
  const recent = recentQueries()
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-6 pt-24 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent-2 text-white shadow-lg shadow-accent/20">
        <Sparkles className="size-6" />
      </div>
      <h1 className="mt-5 text-[22px] font-semibold tracking-tight">Search every tracker at once</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
        One query goes to {enabledCount} trackers in parallel. Results stream in as each site answers, duplicates are merged, and downloads
        start right here.
      </p>
      {recent.length > 0 && (
        <div className="mt-8 w-full">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Recent</div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {recent.map((q) => (
              <Chip key={q} onClick={() => onPick(q)}>
                {q}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
