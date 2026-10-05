import { useEffect, useState } from 'react'
import { ExternalLink, PlayCircle } from 'lucide-react'
import type { TorrentFileInfo, TorrentInfo } from '../../../shared/api'
import { api } from '../api'
import { cx, formatBytes } from '../format'
import { t, tn } from '../i18n'
import { errorText, useStore } from '../store'
import { ProgressBar } from '../ui'
import { Player } from './Player'

// Per-torrent file list: choose what to download, play media while it downloads, open finished files.

export function FilesPanel({ torrent }: { torrent: TorrentInfo }) {
  const toast = useStore((s) => s.toast)
  const [files, setFiles] = useState<TorrentFileInfo[] | null>(null)
  const [playing, setPlaying] = useState<TorrentFileInfo | null>(null)
  const live = torrent.state !== 'paused' && torrent.state !== 'error' && torrent.state !== 'done'

  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .torrentFiles(torrent.infoHash)
        .then((f) => alive && setFiles(f))
        .catch(() => {})
    void load()
    const timer = setInterval(load, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [torrent.infoHash])

  const apply = async (selected: number[]) => {
    setFiles((fs) => fs?.map((f) => ({ ...f, selected: selected.includes(f.index) })) ?? null)
    try {
      await api.setFileSelection(torrent.infoHash, selected)
    } catch (e) {
      toast({ kind: 'error', text: errorText(e) })
    }
  }

  if (!live && !files?.length) return <p className="px-1 py-2 text-[12.5px] text-muted">{t('dl.pausedFiles')}</p>
  if (!files) return null
  if (!files.length) return <p className="px-1 py-2 text-[12.5px] text-muted">{t('dl.noFiles')}</p>

  const selected = files.filter((f) => f.selected).map((f) => f.index)
  const selectedSize = files.filter((f) => f.selected).reduce((s, f) => s + f.length, 0)

  return (
    <div className="mt-3 rounded-lg border border-line bg-bg/60">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-[12px] text-muted">
        <span>
          {tn('dl.filesCount', files.length)} · {formatBytes(selectedSize)}
        </span>
        <div className="ml-auto flex gap-3">
          <button className="hover:text-fg" onClick={() => void apply(files.map((f) => f.index))}>
            {t('dl.selectAll')}
          </button>
          <button className="hover:text-fg" onClick={() => void apply([])}>
            {t('dl.selectNone')}
          </button>
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto py-1">
        {files.map((f) => (
          <div key={f.index} className="group/file flex items-center gap-3 px-3 py-1.5 hover:bg-panel">
            <input
              type="checkbox"
              checked={f.selected}
              onChange={(e) => void apply(e.target.checked ? [...selected, f.index] : selected.filter((i) => i !== f.index))}
              className="size-3.5 shrink-0 accent-[var(--color-accent)]"
            />
            <div className={cx('min-w-0 flex-1', !f.selected && 'opacity-50')}>
              <div className="truncate text-[12.5px] selectable" title={f.path}>
                {f.name}
              </div>
              {f.selected && f.progress < 1 && <ProgressBar value={f.progress} className="mt-1 h-1" />}
            </div>
            <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-muted">{formatBytes(f.length)}</span>
            <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-faint">{Math.floor(f.progress * 100)}%</span>
            <div className="flex w-16 shrink-0 justify-end gap-1">
              {f.playable && live && (
                <button title={t('dl.play')} onClick={() => setPlaying(f)} className="rounded p-1 text-accent hover:bg-accent/15">
                  <PlayCircle className="size-4" />
                </button>
              )}
              {f.progress >= 1 && (
                <button
                  title={t('dl.openFile')}
                  onClick={() => api.openTorrentFile(torrent.infoHash, f.index).catch((e) => toast({ kind: 'error', text: errorText(e) }))}
                  className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
                >
                  <ExternalLink className="size-4" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {playing && <Player infoHash={torrent.infoHash} file={playing} onClose={() => setPlaying(null)} />}
    </div>
  )
}
