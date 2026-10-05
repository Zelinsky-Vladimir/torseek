import { useEffect, useMemo, useState } from 'react'
import { Globe2, RefreshCw } from 'lucide-react'
import type { TrackerCheckStatus } from '../../../shared/api'
import { api } from '../api'
import { cx } from '../format'
import { t } from '../i18n'
import { errorText, useStore } from '../store'
import { Button } from '../ui'

const langOf = (language?: string) => (language ?? 'en').split('-')[0].toLowerCase()

/** Tracker languages with counts, most trackers first */
function useTrackerLanguages() {
  const indexers = useStore((s) => s.indexers)
  return useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of indexers) counts.set(langOf(i.language), (counts.get(langOf(i.language)) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [indexers])
}

function languageName(code: string, ui: string) {
  try {
    const name = new Intl.DisplayNames([ui], { type: 'language' }).of(code)
    return name ? name[0].toUpperCase() + name.slice(1) : code
  } catch {
    return code.toUpperCase()
  }
}

export function LanguagePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const languages = useTrackerLanguages()
  const ui = useStore((s) => s.lang)
  return (
    <div className="flex flex-wrap gap-1.5">
      {languages.map(([code, n]) => {
        const on = value.includes(code)
        return (
          <button
            key={code}
            onClick={() => onChange(on ? value.filter((c) => c !== code) : [...value, code])}
            className={cx('rounded-lg border px-2.5 py-1 text-[12.5px]', on ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:bg-hover hover:text-fg')}
          >
            {languageName(code, ui)} <span className="tabular-nums text-faint">{n}</span>
          </button>
        )
      })}
    </div>
  )
}

/** First launch (and the first launch after this was added): which languages do you search in? */
export function LanguageSetup() {
  const { settings, indexers, lang, saveSettings, toast } = useStore()
  const [value, setValue] = useState<string[] | null>(null)
  if (!settings || settings.searchLanguages?.length || !indexers.length) return null
  const picked = value ?? [...new Set(['en', lang === 'uk' ? 'uk' : lang, ...(lang === 'uk' ? ['ru'] : [])])]

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-[2px]">
      <div className="w-[560px] rounded-2xl border border-line bg-panel p-6 shadow-2xl">
        <div className="flex size-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <Globe2 className="size-5" />
        </div>
        <div className="mt-3 text-[16px] font-semibold">{t('langs.title')}</div>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">{t('langs.hint')}</p>
        <div className="mt-4">
          <LanguagePicker value={picked} onChange={setValue} />
        </div>
        <div className="mt-6 flex justify-end">
          <Button
            variant="primary"
            disabled={!picked.length}
            onClick={async () => {
              try {
                await saveSettings({ searchLanguages: picked })
                await api.checkTrackers()
                toast({ kind: 'info', text: t('langs.checking') })
              } catch (e) {
                toast({ kind: 'error', text: errorText(e) })
              }
            }}
          >
            {t('langs.continue')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Settings row: check every tracker now, with progress and the last check time */
export function TrackerCheckRow() {
  const indexers = useStore((s) => s.indexers)
  const [status, setStatus] = useState<TrackerCheckStatus | null>(null)
  // Progress arrives as "indexers changed" events, which reload the tracker list
  useEffect(() => void api.trackerCheckStatus().then(setStatus), [indexers])

  const hint = status?.running
    ? t('set.checkRunning', { done: status.done, total: status.total })
    : status?.checkedAt
      ? t('set.checkLast', { date: new Date(status.checkedAt).toLocaleString() })
      : t('set.checkNever')
  return (
    <div className="flex items-center gap-6 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{t('set.checkTrackers')}</div>
        <div className="mt-0.5 text-[12.5px] text-muted">{hint}</div>
      </div>
      <Button icon={<RefreshCw className="size-4" />} loading={status?.running} onClick={async () => setStatus(await api.checkTrackers())}>
        {t('set.checkNow')}
      </Button>
    </div>
  )
}
