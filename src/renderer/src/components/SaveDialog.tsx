import { useState } from 'react'
import { Folder, FolderOpen } from 'lucide-react'
import { api } from '../api'
import { t } from '../i18n'
import { cx } from '../format'
import { errorText, useStore } from '../store'
import { Button } from '../ui'

// "Where to save?" before a download starts. The default folder is preselected; the
// checkbox makes it the folder for everything and stops asking (Settings turns it back on).
export function SaveDialog() {
  const { saveRequest, settings, saveSettings, toast } = useStore()
  const [path, setPath] = useState<string | null>(null)
  const [always, setAlways] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!saveRequest || !settings) return null

  const folder = path ?? settings.downloadDir
  const recent = [settings.downloadDir, ...(settings.recentDirs ?? [])].filter((p, i, a) => a.indexOf(p) === i).slice(0, 5)
  const close = () => {
    setPath(null)
    setAlways(false)
    setBusy(false)
    useStore.setState({ saveRequest: undefined })
  }
  const start = async () => {
    setBusy(true)
    try {
      if (always) await saveSettings({ downloadDir: folder, askWhereToSave: false })
      const run = saveRequest.run
      close()
      await run(folder)
    } catch (e) {
      toast({ kind: 'error', text: errorText(e) })
      close()
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-[2px]" onClick={close}>
      <div
        className="w-[520px] rounded-2xl border border-line bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
          if (e.key === 'Enter') void start()
        }}
      >
        <div className="text-[15px] font-semibold">{t('save.title')}</div>
        <div className="mt-1 truncate text-[13px] text-muted" title={saveRequest.title}>
          {saveRequest.title}
        </div>

        <div className="mt-4 space-y-1">
          {recent.map((p) => (
            <button
              key={p}
              onClick={() => setPath(p)}
              className={cx('flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px]', folder === p ? 'border-accent bg-accent/10' : 'border-line hover:bg-hover')}
            >
              <Folder className={cx('size-4 shrink-0', folder === p ? 'text-accent' : 'text-faint')} />
              <span className="min-w-0 flex-1 truncate" title={p}>
                {p}
              </span>
              {p === settings.downloadDir && <span className="shrink-0 text-[11.5px] text-faint">{t('save.default')}</span>}
            </button>
          ))}
          {!recent.includes(folder) && (
            <div className="flex items-center gap-2.5 rounded-lg border border-accent bg-accent/10 px-3 py-2 text-[13px]">
              <Folder className="size-4 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">{folder}</span>
            </div>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="mt-2"
          icon={<FolderOpen className="size-3.5" />}
          onClick={async () => {
            const picked = await api.chooseFolder(folder)
            if (picked) setPath(picked)
          }}
        >
          {t('save.other')}
        </Button>

        <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-[13px]">
          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
          {t('save.dontAsk')}
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void start()} autoFocus>
            {t('save.download')}
          </Button>
        </div>
      </div>
    </div>
  )
}
