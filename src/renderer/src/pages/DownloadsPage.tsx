import { useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, FolderOpen, Inbox, Magnet, Pause, Play, Trash2, Users } from 'lucide-react'
import { FilesPanel } from '../components/FilesPanel'
import type { TorrentInfo, TorrentState } from '../../../shared/api'
import { api } from '../api'
import { cx, formatBytes, formatEta, formatSpeed } from '../format'
import { errorText, useStore } from '../store'
import { Button, EmptyState, IconButton, Input, ProgressBar } from '../ui'
import { t, t as tr, translateError, type Key } from '../i18n'

const STATE_LABEL: Record<TorrentState, Key> = {
  metadata: 'dl.state.metadata',
  downloading: 'dl.state.downloading',
  seeding: 'dl.state.seeding',
  paused: 'dl.state.paused',
  done: 'dl.state.done',
  error: 'dl.state.error',
}

type Filter = 'all' | 'active' | 'done'

export function DownloadsPage() {
  const { torrents, toast } = useStore()
  const [magnet, setMagnet] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [removing, setRemoving] = useState<TorrentInfo | null>(null)

  const totalDown = torrents.reduce((s, t) => s + t.downloadSpeed, 0)
  const totalUp = torrents.reduce((s, t) => s + t.uploadSpeed, 0)
  const shown = torrents.filter((t) =>
    filter === 'all' ? true : filter === 'active' ? ['downloading', 'metadata'].includes(t.state) : ['seeding', 'done'].includes(t.state),
  )

  const addMagnet = async () => {
    if (!magnet.trim().startsWith('magnet:')) return toast({ kind: 'error', text: t('dl.badMagnet') })
    try {
      await api.addMagnet(magnet)
      setMagnet('')
    } catch (e) {
      toast({ kind: 'error', text: errorText(e) })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="drag flex items-center gap-4 border-b border-line/70 px-6 pb-3 pt-3.5">
        <h1 className="text-[17px] font-semibold">{t('dl.title')}</h1>
        <div className="no-drag flex items-center gap-1 rounded-lg bg-panel p-0.5 text-[12.5px]">
          {(['all', 'active', 'done'] as Filter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={cx('whitespace-nowrap rounded-md px-2.5 py-1', filter === f ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}>
              {t(`dl.filter.${f}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[12.5px] tabular-nums text-muted">
          <span className="flex items-center gap-1">
            <ArrowDown className="size-3.5 text-accent" />
            {formatSpeed(totalDown)}
          </span>
          <span className="flex items-center gap-1">
            <ArrowUp className="size-3.5 text-good" />
            {formatSpeed(totalUp)}
          </span>
        </div>
        <form
          className="no-drag mr-[140px] ml-auto flex w-[380px] gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void addMagnet()
          }}
        >
          <Input value={magnet} onChange={(e) => setMagnet(e.target.value)} placeholder={t('dl.magnetPlaceholder')} className="flex-1" />
          <Button type="submit" icon={<Magnet className="size-4" />} disabled={!magnet.trim()}>
            {t('dl.add')}
          </Button>
        </form>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {shown.length === 0 ? (
          <EmptyState icon={<Inbox className="size-6" />} title={torrents.length ? t('dl.noneTitle') : t('dl.emptyTitle')}>
            {torrents.length ? t('dl.noneText') : t('dl.emptyText')}
          </EmptyState>
        ) : (
          shown.map((t) => <TorrentRow key={t.infoHash} t={t} onRemove={() => setRemoving(t)} />)
        )}
      </div>

      {removing && <RemoveDialog t={removing} onClose={() => setRemoving(null)} />}
    </div>
  )
}

function TorrentRow({ t, onRemove }: { t: TorrentInfo; onRemove: () => void }) {
  const toast = useStore((s) => s.toast)
  const active = ['downloading', 'metadata', 'seeding'].includes(t.state)
  const run = (p: Promise<unknown>) => p.catch((e) => toast({ kind: 'error', text: errorText(e) }))
  const tone = t.state === 'error' ? 'bad' : t.state === 'seeding' || t.state === 'done' ? 'good' : t.state === 'paused' ? 'muted' : 'accent'
  const [open, setOpen] = useState(false)

  return (
    <div className={cx('group rounded-xl px-3 py-3 hover:bg-panel', open && 'bg-panel')}>
      <div className="flex items-center gap-4">
        <button onClick={() => setOpen(!open)} className="-ml-1 rounded p-0.5 text-faint hover:text-fg" aria-label={tr('dl.files')} title={tr('dl.files')}>
          <ChevronDown className={cx('size-4 transition-transform', !open && '-rotate-90')} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium selectable" title={t.name}>
            {t.name}
          </div>
          <div className="mt-1 flex items-center gap-3 text-[12px] tabular-nums text-muted">
            <span className={cx(t.state === 'error' ? 'text-bad' : t.state === 'seeding' ? 'text-good' : '')}>{tr(STATE_LABEL[t.state])}</span>
            {t.length > 0 && (
              <span>{tr('dl.progress', { done: formatBytes(t.downloaded), total: formatBytes(t.length) })}</span>
            )}
            {t.state === 'downloading' && <span>{tr('dl.eta', { t: formatEta(t.timeRemaining) })}</span>}
            {active && (
              <span className="flex items-center gap-1">
                <Users className="size-3" />
                {t.numPeers}
              </span>
            )}
            {t.partial && <span className="text-warn">{tr('dl.partial')}</span>}
            {t.source && <span className="text-faint">{tr('dl.from', { name: t.source.indexerName })}</span>}
            {t.error && <span className="truncate text-bad">{translateError(t.error)}</span>}
          </div>
        </div>
        <div className="w-[150px] text-right text-[12.5px] tabular-nums text-muted">
          {active && (
            <>
              <div className="flex items-center justify-end gap-1">
                <ArrowDown className="size-3 text-accent" />
                {formatSpeed(t.downloadSpeed)}
              </div>
              <div className="flex items-center justify-end gap-1">
                <ArrowUp className="size-3 text-good" />
                {formatSpeed(t.uploadSpeed)}
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {active ? (
            <IconButton label={tr('dl.pause')} onClick={() => void run(api.pauseTorrent(t.infoHash))}>
              <Pause className="size-4" />
            </IconButton>
          ) : (
            <IconButton label={tr('dl.resume')} onClick={() => void run(api.resumeTorrent(t.infoHash))}>
              <Play className="size-4" />
            </IconButton>
          )}
          <IconButton label={tr('dl.showFolder')} onClick={() => void run(api.openTorrentFolder(t.infoHash))}>
            <FolderOpen className="size-4" />
          </IconButton>
          <IconButton label={tr('dl.remove')} onClick={onRemove} className="hover:!text-bad">
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <ProgressBar value={t.progress} tone={tone} className="flex-1" />
        <span className="w-11 text-right text-[12px] font-semibold tabular-nums text-muted">{Math.floor(t.progress * 100)}%</span>
      </div>
      {open && <FilesPanel torrent={t} />}
    </div>
  )
}

function RemoveDialog({ t, onClose }: { t: TorrentInfo; onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-[440px] rounded-2xl border border-line bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="text-[15px] font-semibold">{tr('dl.removeTitle')}</div>
        <div className="mt-1.5 truncate text-[13px] text-muted" title={t.name}>
          {t.name}
        </div>
        <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-[13px]">
          <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} className="size-4 accent-[var(--color-bad)]" />
          {tr('dl.deleteFiles')}
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {tr('common.cancel')}
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await api.removeTorrent(t.infoHash, deleteFiles)
                onClose()
              } catch (e) {
                toast({ kind: 'error', text: errorText(e) })
                setBusy(false)
              }
            }}
          >
            {deleteFiles ? tr('dl.removeAndDelete') : tr('dl.remove')}
          </Button>
        </div>
      </div>
    </div>
  )
}
