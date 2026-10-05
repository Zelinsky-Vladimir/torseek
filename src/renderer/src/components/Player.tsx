import { useEffect, useState } from 'react'
import { Copy, Loader2, X } from 'lucide-react'
import type { TorrentFileInfo } from '../../../shared/api'
import { api } from '../api'
import { t } from '../i18n'
import { errorText, useStore } from '../store'
import { Button } from '../ui'

// Plays a file while it downloads, from the client's local streaming server. Chromium
// handles MP4/WebM (H.264, VP9, AV1) and most MKVs with those codecs; for everything
// else the stream URL can be opened in VLC.

const AUDIO = /\.(mp3|flac|m4a|aac|ogg|opus|wav)$/i

export function Player({ infoHash, file, onClose }: { infoHash: string; file: TorrentFileInfo; onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const [url, setUrl] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'playing' | 'unsupported'>('loading')

  useEffect(() => {
    api
      .streamUrl(infoHash, file.index)
      .then(setUrl)
      .catch((e) => {
        toast({ kind: 'error', text: errorText(e) })
        onClose()
      })
  }, [infoHash, file.index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = async () => {
    if (!url) return
    await navigator.clipboard.writeText(url)
    toast({ kind: 'info', text: t('player.copied') })
  }

  const media = {
    src: url ?? undefined,
    controls: true,
    autoPlay: true,
    onPlaying: () => setState('playing'),
    onError: () => setState('unsupported'),
    className: 'max-h-[70vh] w-full rounded-lg bg-black',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-3">
          <div className="min-w-0 flex-1 truncate text-[14px] font-medium text-white" title={file.path}>
            {file.name}
          </div>
          <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copy()} disabled={!url}>
            {t('player.copyUrl')}
          </Button>
          <button onClick={onClose} className="rounded-lg p-1.5 text-white/70 hover:bg-white/10 hover:text-white" aria-label={t('common.dismiss')}>
            <X className="size-5" />
          </button>
        </div>
        {state === 'unsupported' ? (
          <div className="rounded-lg border border-line bg-panel px-6 py-10 text-center text-[13.5px] text-muted">{t('player.unsupported')}</div>
        ) : (
          <div className="relative">
            {AUDIO.test(file.name) ? <audio {...media} className="w-full" /> : <video {...media} />}
            {state === 'loading' && (
              <div className="pointer-events-none absolute inset-x-0 bottom-14 flex items-center justify-center gap-2 text-[12.5px] text-white/80">
                <Loader2 className="size-4 animate-spin" />
                {t('player.buffering')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
