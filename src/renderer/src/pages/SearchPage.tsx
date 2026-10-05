import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, BellRing, ChevronDown, ExternalLink, Loader2, Search, ShieldAlert, Sparkles, Star, X, Languages } from 'lucide-react'
import { matchesFilters, relevance, type AudioFilter, type SubsFilter } from '../../../core/filters'
import { groupReleases, type ReleaseGroup } from '../../../core/release'
import type { IndexerStatus, TitleInfo } from '../../../shared/api'
import { CATEGORY_CHIPS } from '../categories'
import { ResultHeader, ResultRow } from '../components/ResultRow'
import { cx } from '../format'
import { t, tn, translateError, type Key } from '../i18n'
import { useStore, type SortKey } from '../store'
import { Chip, EmptyState, IconButton } from '../ui'

const SORTS: { id: SortKey; label: Key }[] = [
  { id: 'relevance', label: 'search.sort.relevance' },
  { id: 'seeders', label: 'search.sort.seeders' },
  { id: 'newest', label: 'search.sort.newest' },
  { id: 'size-desc', label: 'search.sort.sizeDesc' },
  { id: 'size-asc', label: 'search.sort.sizeAsc' },
  { id: 'name', label: 'search.sort.name' },
]
const RESOLUTIONS = ['2160p', '1080p', '720p', '480p'] as const
const resLabel = (r: string) => (r === '2160p' ? '4K' : r === '480p' ? 'SD' : r)
const PAGE = 150

const AUDIO: AudioFilter[] = ['en', 'ru', 'uk']
const SUBS: SubsFilter[] = ['any', 'en', 'ru', 'uk']

const SORTERS: Record<SortKey, (a: ReleaseGroup, b: ReleaseGroup) => number> = {
  // Relevance tiers are applied in the page; within a tier, best seeded first
  relevance: (a, b) => (b.primary.seeders ?? -1) - (a.primary.seeders ?? -1),
  seeders: (a, b) => (b.primary.seeders ?? -1) - (a.primary.seeders ?? -1),
  newest: (a, b) => (b.primary.publishDate ?? '').localeCompare(a.primary.publishDate ?? ''),
  'size-desc': (a, b) => (b.primary.size ?? 0) - (a.primary.size ?? 0),
  'size-asc': (a, b) => (a.primary.size ?? Infinity) - (b.primary.size ?? Infinity),
  name: (a, b) => a.primary.title.localeCompare(b.primary.title),
}

const isVideo = (cats: number[]) => cats.some((c) => Math.floor(c / 1000) === 2 || Math.floor(c / 1000) === 5)

export function SearchPage() {
  const { query, setQuery, runSearch, cancelSearch, running, releases, statuses, chips, setChips, settings, indexers } = useStore()
  const { resolutions, minSeeds, sort, setFilters, title, watches, watchCurrent, audio, subs, probes, searchedQuery, alsoSearched } = useStore()
  const [showLoose, setShowLoose] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
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

  useEffect(() => setLimit(PAGE), [releases.length === 0, chips, resolutions, minSeeds, sort, audio, subs])
  useEffect(() => setShowLoose(false), [searchedQuery])

  const groups = useMemo(() => [...groupReleases(releases).values()], [releases])
  const showAdult = !!settings?.showAdult

  const visibleChips = CATEGORY_CHIPS.filter((c) => !c.adult || showAdult)
  const chipCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const g of groups) for (const c of visibleChips) if (g.primary.categories.some(c.match)) counts[c.id] = (counts[c.id] ?? 0) + 1
    return counts
  }, [groups, showAdult])

  // Trackers pad results with loosely related torrents; those go under "show N more"
  const scores = useMemo(() => {
    const terms = [searchedQuery, ...alsoSearched, ...(title ? [title.name] : [])].filter(Boolean)
    return new Map(groups.map((g) => [g.key, Math.max(...g.sources.map((s) => relevance(s.title, terms)))]))
  }, [groups, searchedQuery, alsoSearched, title])

  const { filtered, hiddenLoose } = useMemo(() => {
    const matching = groups.filter((g) => matchesFilters(g.primary, { chips, resolutions, minSeeds, audio, subs, showAdult }, g.quality.resolution, g.audio, probes[g.key]?.tracks))
    const score = (g: ReleaseGroup) => scores.get(g.key) ?? 0
    const relevant = matching.filter((g) => score(g) > 0)
    // Nothing matches by words (the site found it by something else): don't hide everything
    const shown = showLoose || relevant.length === 0 ? matching : relevant
    const tier = (g: ReleaseGroup) => (sort === 'relevance' ? score(g) : Math.min(1, score(g)))
    return { filtered: shown.sort((a, b) => tier(b) - tier(a) || SORTERS[sort](a, b)), hiddenLoose: matching.length - shown.length }
  }, [groups, scores, chips, resolutions, minSeeds, audio, subs, probes, sort, showAdult, showLoose])

  const enabledCount = indexers.filter((i) => i.enabled).length
  const watched = watches.some((w) => w.query.toLowerCase() === query.trim().toLowerCase())
  // A movie/series card only makes sense when the results are mostly video
  const videoShare = groups.length ? groups.filter((g) => isVideo(g.primary.categories)).length / groups.length : 0
  const showTitle = !!title && hasSearched && (videoShare >= 0.3 || (running && groups.length < 20))

  const toggleResolution = (r: string) => setFilters({ resolutions: resolutions.includes(r) ? resolutions.filter((x) => x !== r) : [...resolutions, r] })

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
            placeholder={t('search.placeholder', { n: enabledCount })}
            className="selectable h-11 w-full rounded-xl border border-line bg-panel pl-11 pr-28 text-[15px] outline-none transition-colors placeholder:text-faint focus:border-accent/70 focus:bg-panel-2"
          />
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {query && (
              <IconButton type="button" label={t('common.clear')} onClick={() => setQuery('')} className="size-7">
                <X className="size-4" />
              </IconButton>
            )}
            <kbd className="rounded border border-line px-1.5 py-0.5 text-[11px] text-faint">Ctrl K</kbd>
          </div>
        </form>

        <div className="no-drag mt-3 flex flex-wrap items-center gap-1.5">
          <Chip active={chips.length === 0} onClick={() => setChips([])} count={hasSearched ? groups.length : undefined}>
            {t('search.all')}
          </Chip>
          {visibleChips.map((c) => (
            <Chip
              key={c.id}
              active={chips.includes(c.id)}
              count={hasSearched ? (chipCounts[c.id] ?? 0) : undefined}
              onClick={() => setChips(chips.includes(c.id) ? chips.filter((x) => x !== c.id) : [...chips, c.id])}
            >
              {t(c.label)}
            </Chip>
          ))}
        </div>
      </div>

      {hasSearched && <TrackerProgress statuses={statuses} running={running} onCancel={cancelSearch} />}

      {hasSearched && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 whitespace-nowrap border-b border-line/70 px-6 py-2 text-[12.5px] text-muted">
          <span className="tabular-nums">
            <span className="text-fg">{tn('search.results', filtered.length)}</span>
            {filtered.length !== groups.length && <span className="text-faint"> {t('search.ofTotal', { n: groups.length })}</span>}
          </span>
          {(hiddenLoose > 0 || showLoose) && (
            <button onClick={() => setShowLoose(!showLoose)} title={t('search.looseHint')} className="text-faint underline-offset-2 hover:text-fg hover:underline">
              {showLoose ? t('search.hideLoose') : tn('search.showLoose', hiddenLoose)}
            </button>
          )}
          <div className="h-4 w-px bg-line" />
          <div className="flex items-center gap-1">
            {RESOLUTIONS.map((r) => (
              <button
                key={r}
                onClick={() => toggleResolution(r)}
                className={cx('rounded-md px-2 py-0.5 font-medium transition-colors', resolutions.includes(r) ? 'bg-accent/15 text-fg' : 'hover:text-fg')}
              >
                {resLabel(r)}
              </button>
            ))}
          </div>
          <div className="h-4 w-px bg-line" />
          <label className="flex items-center gap-2">
            {t('search.minSeeds')}
            <select value={minSeeds} onChange={(e) => setFilters({ minSeeds: Number(e.target.value) })} className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-fg outline-none">
              {[0, 1, 5, 20, 100].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? t('search.any') : `${n}+`}
                </option>
              ))}
            </select>
          </label>
          <div className="h-4 w-px bg-line" />
          <label className="flex items-center gap-2" title={t('search.audioHint')}>
            {t('search.audio')}
            <select
              value={audio ?? ''}
              onChange={(e) => setFilters({ audio: (e.target.value || undefined) as AudioFilter | undefined })}
              className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-fg outline-none"
            >
              <option value="">{t('search.any')}</option>
              {AUDIO.map((a) => (
                <option key={a} value={a}>
                  {t(`search.audio.${a}` as Key)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2" title={t('search.subsHint')}>
            {t('search.subs')}
            <select
              value={subs ?? ''}
              onChange={(e) => setFilters({ subs: (e.target.value || undefined) as SubsFilter | undefined })}
              className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-fg outline-none"
            >
              <option value="">{t('search.any')}</option>
              {SUBS.map((s) => (
                <option key={s} value={s}>
                  {t(`search.subs.${s}` as Key)}
                </option>
              ))}
            </select>
          </label>
          <div className="ml-auto flex items-center gap-3">
            <button
              onClick={() => !watched && void watchCurrent()}
              title={t('search.watchHint')}
              className={cx('flex items-center gap-1.5 rounded-md px-2 py-0.5 font-medium', watched ? 'text-accent' : 'hover:bg-hover hover:text-fg')}
            >
              {watched ? <BellRing className="size-3.5" /> : <Bell className="size-3.5" />}
              {watched ? t('search.watching') : t('search.watch')}
            </button>
            <div className="h-4 w-px bg-line" />
            <span>{t('search.sort')}</span>
            <select value={sort} onChange={(e) => setFilters({ sort: e.target.value as SortKey })} className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-fg outline-none">
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {t(s.label)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!hasSearched ? (
          <Welcome
            enabledCount={enabledCount}
            onPick={(q) => {
              setQuery(q)
              setTimeout(() => void useStore.getState().runSearch())
            }}
          />
        ) : (
          <>
            {showTitle && <TitleCard title={title!} groups={groups.filter((g) => isVideo(g.primary.categories))} onResolution={toggleResolution} active={resolutions} />}
            {filtered.length === 0 ? (
              running ? (
                <ResultSkeleton />
              ) : (
                <EmptyState icon={<Search className="size-6" />} title={t('search.nothing')}>
                  {t('search.nothingHint')}
                </EmptyState>
              )
            ) : (
              <div className="px-3 py-2">
                <ResultHeader />
                {filtered.slice(0, limit).map((g) => (
                  <ResultRow key={g.key} group={g} />
                ))}
                {filtered.length > limit && (
                  <div className="flex justify-center py-4">
                    <button onClick={() => setLimit(limit + PAGE)} className="rounded-lg border border-line px-4 py-2 text-[13px] text-muted hover:bg-hover hover:text-fg">
                      {t('search.showMore', { n: Math.min(PAGE, filtered.length - limit) })}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function TitleCard({ title, groups, active, onResolution }: { title: TitleInfo; groups: ReleaseGroup[]; active: string[]; onResolution: (r: string) => void }) {
  const buckets = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const g of groups) counts[g.quality.resolution ?? 'other'] = (counts[g.quality.resolution ?? 'other'] ?? 0) + 1
    return counts
  }, [groups])

  return (
    <div className="mx-6 mt-4 flex gap-4 rounded-xl border border-line bg-panel p-3">
      {title.poster && <img src={title.poster} alt="" className="h-36 w-24 shrink-0 rounded-lg object-cover" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h2 className="truncate text-[17px] font-semibold">{title.name}</h2>
          {title.year && <span className="text-[13px] text-muted">{title.year}</span>}
          <span className="rounded bg-line/70 px-1.5 text-[11px] font-semibold text-muted">{t(title.type === 'movie' ? 'title.movie' : 'title.series')}</span>
          {title.rating != null && (
            <span className="flex items-center gap-1 text-[13px] font-semibold text-warn">
              <Star className="size-3.5 fill-current" />
              {title.rating.toFixed(1)}
            </span>
          )}
          {title.url && (
            <button onClick={() => void window.open(title.url, '_blank')} className="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-muted hover:text-fg">
              IMDb
              <ExternalLink className="size-3" />
            </button>
          )}
        </div>
        {title.genres?.length ? <div className="mt-0.5 text-[12px] text-faint">{title.genres.join(' · ')}</div> : null}
        {title.description && <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-muted selectable">{title.description}</p>}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('title.byQuality')}</span>
          {RESOLUTIONS.filter((r) => buckets[r]).map((r) => (
            <Chip key={r} active={active.includes(r)} count={buckets[r]} onClick={() => onResolution(r)}>
              {resLabel(r)}
            </Chip>
          ))}
          {buckets.other ? (
            <span className="text-[12px] text-faint">
              {t('title.other')} {buckets.other}
            </span>
          ) : null}
        </div>
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
  timeout: 'text-warn',
  cancelled: 'text-faint',
}

function TrackerProgress({ statuses, running, onCancel }: { statuses: Record<string, IndexerStatus>; running: boolean; onCancel: () => void }) {
  const [open, setOpen] = useState(false)
  const { passChallenge, alsoSearched } = useStore()
  const list = Object.values(statuses)
  const finished = list.filter((s) => !['queued', 'running'].includes(s.state)).length
  const withResults = list.filter((s) => s.state === 'done' && (s.count ?? 0) > 0).length
  const problems = list.filter((s) => ['error', 'blocked', 'timeout'].includes(s.state)).length
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
            <span className="tabular-nums">{t('search.progress.running', { done: finished, total: list.length })}</span>
          ) : (
            <span className="tabular-nums">{t('search.progress.done', { done: withResults, total: list.length })}</span>
          )}
          {problems > 0 && (
            <span className="flex items-center gap-1 text-warn">
              <ShieldAlert className="size-3.5" />
              {tn('search.progress.problems', problems)}
            </span>
          )}
          <ChevronDown className={cx('size-3.5 transition-transform', open && 'rotate-180')} />
        </button>
        {alsoSearched.length > 0 && (
          <span className="flex min-w-0 items-center gap-1.5 text-faint" title={alsoSearched.join(', ')}>
            <Languages className="size-3.5 shrink-0" />
            <span className="truncate">{t('search.alsoSearched', { names: alsoSearched.join(', ') })}</span>
          </span>
        )}
        {running && (
          <button onClick={onCancel} className="ml-auto text-muted hover:text-fg">
            {t('search.stop')}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap gap-1.5 pb-1">
          {sorted.map((s) => {
            const actionable = s.state === 'blocked'
            return (
              <button
                key={s.indexerId}
                disabled={!actionable}
                onClick={() => void passChallenge(s.indexerId, s.indexerName)}
                title={
                  s.state === 'blocked'
                    ? t('search.chip.blockedHint')
                    : s.error
                      ? translateError(s.error)
                      : s.state === 'timeout'
                        ? t('search.chip.timeoutHint')
                        : undefined
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
                  {s.state === 'done' ? s.count : s.state === 'running' || s.state === 'queued' ? '' : s.state === 'blocked' ? t('search.chip.unlock') : s.state === 'timeout' ? t('search.chip.timeout') : t('search.chip.error')}
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
  const recent = useStore((s) => s.history).slice(0, 8)
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-6 pt-24 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent-2 text-white shadow-lg shadow-accent/20">
        <Sparkles className="size-6" />
      </div>
      <h1 className="mt-5 text-[22px] font-semibold tracking-tight">{t('search.welcome.title')}</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{t('search.welcome.text', { n: enabledCount })}</p>
      {recent.length > 0 && (
        <div className="mt-8 w-full">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('search.recent')}</div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {recent.map((h) => (
              <Chip key={h.query} onClick={() => onPick(h.query)}>
                {h.query}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
