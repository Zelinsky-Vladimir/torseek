import { useEffect, useState, type ReactNode } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import type { AppSettings, DefinitionsStatus } from '../../../shared/api'
import { api } from '../api'
import { LANGUAGES, t } from '../i18n'
import { errorText, useStore } from '../store'
import { Button, Input, Toggle } from '../ui'

export function SettingsPage() {
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  const save = (patch: Partial<AppSettings>) => void saveSettings(patch)

  return (
    <div className="flex h-full flex-col">
      <div className="drag border-b border-line/70 px-6 pb-3 pt-3.5">
        <h1 className="text-[17px] font-semibold">{t('set.title')}</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-2xl space-y-8">
          <Section title={t('set.section.general')}>
            <Row label={t('set.language')} hint={t('set.languageHint')}>
              <select
                value={settings.language}
                onChange={(e) => save({ language: e.target.value as AppSettings['language'] })}
                className="h-9 rounded-lg border border-line bg-panel-2 px-2 text-[13px] outline-none"
              >
                <option value="auto">{t('set.language.auto')}</option>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Row>
          </Section>

          <Section title={t('set.section.downloads')}>
            <Row label={t('set.saveTo')} hint={t('set.saveToHint')}>
              <div className="flex gap-2">
                <Input readOnly value={settings.downloadDir} className="flex-1" />
                <Button
                  icon={<FolderOpen className="size-4" />}
                  onClick={async () => {
                    const dir = await api.chooseDownloadDir()
                    if (dir) useStore.setState({ settings: { ...settings, downloadDir: dir } })
                  }}
                >
                  {t('set.change')}
                </Button>
              </div>
            </Row>
            <Row label={t('set.seed')} hint={t('set.seedHint')}>
              <Toggle checked={settings.seedAfterDownload} onChange={(v) => save({ seedAfterDownload: v })} />
            </Row>
            <Row label={t('set.dlLimit')} hint={t('set.limitHint')}>
              <NumberInput value={settings.downloadLimit} onCommit={(v) => save({ downloadLimit: v })} />
            </Row>
            <Row label={t('set.ulLimit')} hint={t('set.limitHint')}>
              <NumberInput value={settings.uploadLimit} onCommit={(v) => save({ uploadLimit: v })} />
            </Row>
          </Section>

          <Section title={t('set.section.search')}>
            <Row label={t('set.parallel')} hint={t('set.parallelHint')}>
              <NumberInput value={settings.searchConcurrency} min={1} max={64} onCommit={(v) => save({ searchConcurrency: v })} />
            </Row>
            <Row label={t('set.timeout')} hint={t('set.timeoutHint')}>
              <NumberInput value={settings.searchTimeoutSec} min={5} max={120} onCommit={(v) => save({ searchTimeoutSec: v })} />
            </Row>
            <Row label={t('set.adult')} hint={t('set.adultHint')}>
              <Toggle checked={settings.showAdult} onChange={(v) => save({ showAdult: v })} />
            </Row>
          </Section>

          <Section title={t('set.section.trackers')}>
            <DefinitionsRow />
          </Section>

          <Section title={t('set.section.about')}>
            <p className="px-4 py-3.5 text-[13px] leading-relaxed text-muted">{t('set.about')}</p>
          </Section>
        </div>
      </div>
    </div>
  )
}

function DefinitionsRow() {
  const toast = useStore((s) => s.toast)
  const [status, setStatus] = useState<DefinitionsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => void api.definitionsStatus().then(setStatus), [])

  const hint = status?.checkedAt ? t('set.definitionsLast', { date: new Date(status.checkedAt).toLocaleString() }) : t('set.definitionsNever')

  return (
    <Row label={t('set.definitions')} hint={hint}>
      <Button
        icon={<RefreshCw className="size-4" />}
        loading={busy || status?.updating}
        onClick={async () => {
          setBusy(true)
          try {
            const s = await api.updateDefinitions()
            setStatus({ ...s })
            if (s.error) toast({ kind: 'error', text: t('set.updateFailed', { error: s.error }) })
            else {
              const r = s.lastResult!
              const changed = r.updated + r.added + r.removed
              toast({ kind: 'success', text: changed ? t('set.updateResult', { updated: r.updated, added: r.added, removed: r.removed }) : t('set.upToDate') })
            }
          } catch (e) {
            toast({ kind: 'error', text: errorText(e) })
          } finally {
            setBusy(false)
          }
        }}
      >
        {t('set.updateNow')}
      </Button>
    </Row>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</h2>
      <div className="divide-y divide-line/70 rounded-xl border border-line bg-panel">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12.5px] text-muted">{hint}</div>}
      </div>
      <div className="w-auto max-w-[60%] shrink-0">{children}</div>
    </div>
  )
}

function NumberInput({ value, onCommit, min = 0, max }: { value: number; onCommit: (v: number) => void; min?: number; max?: number }) {
  return (
    <Input
      type="number"
      defaultValue={value}
      min={min}
      max={max}
      className="w-24 text-right tabular-nums"
      onBlur={(e) => {
        const v = Math.max(min, Math.min(max ?? Infinity, Number(e.target.value) || 0))
        e.target.value = String(v)
        if (v !== value) onCommit(v)
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}
