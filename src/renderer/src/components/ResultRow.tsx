import { ArrowDownToLine, Check, CircleAlert, ExternalLink, Loader2, Magnet, Star } from 'lucide-react'
import { groupKey, type ReleaseGroup } from '../../../core/release'
import { categoryLabel } from '../categories'
import { cx, formatAge, formatBytes, formatCount } from '../format'
import { t } from '../i18n'
import { grabStateOf, useStore } from '../store'
import { Badge, IconButton } from '../ui'

// One search result (a release, possibly found on several trackers). Used by the search
// screen and the library.

export const RESULT_GRID = 'grid grid-cols-[minmax(0,1fr)_88px_96px_56px_144px] gap-x-3'

export function ResultHeader() {
  return (
    <div className={cx(RESULT_GRID, 'px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint')}>
      <div>{t('search.col.name')}</div>
      <div className="text-right">{t('search.col.size')}</div>
      <div className="text-right">{t('search.col.seeds')}</div>
      <div className="text-right">{t('search.col.age')}</div>
      <div />
    </div>
  )
}

export function ResultRow({ group, highlight }: { group: ReleaseGroup; highlight?: boolean }) {
  const r = group.primary
  const { grab, copyMagnet, grabs, favoriteKeys, toggleFavorite } = useStore()
  const state = grabStateOf(grabs, r)
  const q = group.quality
  const cat = categoryLabel(r.categories)
  const others = group.sources.filter((s) => s !== r)
  const freeleech = r.downloadVolumeFactor === 0
  const starred = favoriteKeys.has(groupKey(r))

  return (
    <div className={cx('group items-center rounded-lg px-3 py-2 hover:bg-panel', RESULT_GRID, highlight && 'bg-accent/5')}>
      <div className="min-w-0">
        <div className="truncate text-[13.5px] font-medium leading-5 text-fg selectable" title={r.title}>
          {highlight && <span className="mr-1.5 inline-block size-1.5 -translate-y-0.5 rounded-full bg-accent" />}
          {r.title}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 overflow-hidden text-[12px] text-muted">
          {q.resolution && <Badge tone={q.resolution === '2160p' ? 'accent' : 'neutral'}>{q.resolution === '2160p' ? '4K' : q.resolution}</Badge>}
          {q.hdr && <Badge tone="warn">{q.hdr}</Badge>}
          {q.source && <Badge tone={q.source === 'CAM' ? 'bad' : 'neutral'}>{q.source}</Badge>}
          {q.codec && <Badge>{q.codec}</Badge>}
          {freeleech && <Badge tone="good">{t('search.free')}</Badge>}
          <span className="truncate">
            <span className="text-fg/80">{r.indexerName}</span>
            {others.length > 0 && (
              <span className="text-faint" title={others.map((o) => o.indexerName).join(', ')}>
                {' '}
                {t('search.moreSources', { n: others.length })}
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
          <IconButton label={t('search.openDetails')} onClick={() => void window.open(r.details, '_blank')} className="opacity-0 group-hover:opacity-100">
            <ExternalLink className="size-4" />
          </IconButton>
        )}
        <IconButton label={t('search.copyMagnet')} onClick={() => void copyMagnet(r)} className="opacity-0 group-hover:opacity-100">
          <Magnet className="size-4" />
        </IconButton>
        <IconButton
          label={starred ? t('search.unstar') : t('search.star')}
          onClick={() => void toggleFavorite(r)}
          className={cx(starred ? '!text-warn' : 'opacity-0 group-hover:opacity-100')}
        >
          <Star className={cx('size-4', starred && 'fill-current')} />
        </IconButton>
        <button
          onClick={() => void grab(r)}
          disabled={state === 'loading'}
          title={t('search.download')}
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
