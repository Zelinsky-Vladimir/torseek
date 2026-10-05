import { useEffect, useState, type ReactNode } from 'react'
import { Copy, Download, FolderOpen, KeyRound, RefreshCw } from 'lucide-react'
import type { AppSettings, DefinitionsStatus, TorznabStatus } from '../../../shared/api'
import { api } from '../api'
import { LANGUAGES, t, type Key } from '../i18n'
import { ACCENT_IDS, ACCENTS, resolveTheme, THEME_IDS, THEMES, type AccentId, type Palette, type ThemeSetting } from '../../../shared/themes'
import { cx } from '../format'
import { LanguagePicker, TrackerCheckRow } from '../components/TrackerLanguages'
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
            <Row label={t('set.closeToTray')} hint={t('set.closeToTrayHint')}>
              <Toggle checked={settings.closeToTray} onChange={(v) => save({ closeToTray: v })} />
            </Row>
            <Row label={t('set.notify')} hint={t('set.notifyHint')}>
              <Toggle checked={settings.notifyOnComplete} onChange={(v) => save({ notifyOnComplete: v })} />
            </Row>
            <Row label={t('set.autostart')} hint={t('set.autostartHint')}>
              <Toggle checked={settings.openAtLogin} onChange={(v) => save({ openAtLogin: v })} />
            </Row>
            <MagnetRow />
          </Section>

          <AppearanceSection settings={settings} save={save} />

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
            <Row label={t('set.askSave')} hint={t('set.askSaveHint')}>
              <Toggle checked={settings.askWhereToSave} onChange={(v) => save({ askWhereToSave: v })} />
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
            <Row label={t('set.liveSeeds')} hint={t('set.liveSeedsHint')}>
              <Toggle checked={settings.liveSeeds} onChange={(v) => save({ liveSeeds: v })} />
            </Row>
            <Row label={t('set.otherLanguages')} hint={t('set.otherLanguagesHint')}>
              <Toggle checked={settings.searchOtherLanguages} onChange={(v) => save({ searchOtherLanguages: v })} />
            </Row>
            <Row label={t('set.titleInfo')} hint={t('set.titleInfoHint')}>
              <Toggle checked={settings.showTitleInfo} onChange={(v) => save({ showTitleInfo: v })} />
            </Row>
            <Row label={t('set.adult')} hint={t('set.adultHint')}>
              <Toggle checked={settings.showAdult} onChange={(v) => save({ showAdult: v })} />
            </Row>
          </Section>

          <TorznabSection settings={settings} save={save} />

          <Section title={t('set.section.trackers')}>
            <div className="px-4 py-3.5">
              <div className="text-[13.5px] font-medium">{t('set.searchLanguages')}</div>
              <div className="mt-0.5 text-[12.5px] text-muted">{t('set.searchLanguagesHint')}</div>
              <div className="mt-3">
                <LanguagePicker value={settings.searchLanguages} onChange={(v) => save({ searchLanguages: v })} />
              </div>
            </div>
            <Row label={t('set.autoManage')} hint={t('set.autoManageHint')}>
              <Toggle checked={settings.autoManageTrackers} onChange={(v) => save({ autoManageTrackers: v })} />
            </Row>
            <TrackerCheckRow />
            <DefinitionsRow />
          </Section>

          <Section title={t('set.section.about')}>
            <UpdatesRow />
            <p className="px-4 py-3.5 text-[13px] leading-relaxed text-muted">{t('set.about')}</p>
          </Section>
        </div>
      </div>
    </div>
  )
}

function AppearanceSection({ settings, save }: { settings: AppSettings; save: (p: Partial<AppSettings>) => void }) {
  const scheme = THEMES[resolveTheme(settings.theme, window.matchMedia('(prefers-color-scheme: dark)').matches)].scheme
  return (
    <Section title={t('set.section.appearance')}>
      <div className="px-4 py-3.5">
        <div className="text-[13.5px] font-medium">{t('set.theme')}</div>
        <div className="mt-3 grid grid-cols-7 gap-2.5">
          {(['system', ...THEME_IDS] as ThemeSetting[]).map((id) => (
            <ThemeCard key={id} id={id} accent={settings.accent} active={settings.theme === id} onClick={() => save({ theme: id })} />
          ))}
        </div>
      </div>
      <Row label={t('set.accent')}>
        <div className="flex gap-2.5">
          {ACCENT_IDS.map((a) => (
            <button
              key={a}
              aria-label={a}
              title={a}
              onClick={() => save({ accent: a })}
              className={cx('size-6 rounded-full ring-offset-2 ring-offset-panel transition-transform hover:scale-110', settings.accent === a && 'ring-2 ring-fg')}
              style={{ background: ACCENTS[a][scheme][0] }}
            />
          ))}
        </div>
      </Row>
    </Section>
  )
}

// A tiny window drawn in the theme's own colors
function ThemeCard({ id, accent, active, onClick }: { id: ThemeSetting; accent: AccentId; active: boolean; onClick: () => void }) {
  const preview = (p: Palette) => (
    <div className="flex flex-1 flex-col gap-1 p-1.5" style={{ background: p.bg }}>
      <div className="h-1.5 w-3/4 rounded-sm" style={{ background: p['line-2'] }} />
      <div className="flex-1 rounded" style={{ background: p.panel, border: `1px solid ${p.line}` }} />
      <div className="h-1.5 w-1/2 rounded-sm" style={{ background: ACCENTS[accent][p.scheme][0] }} />
    </div>
  )
  return (
    <button onClick={onClick} className="group min-w-0 text-left" aria-pressed={active}>
      <div className={cx('flex h-16 overflow-hidden rounded-lg border', active ? 'border-accent ring-1 ring-accent' : 'border-line group-hover:border-line-2')}>
        {id === 'system' ? (
          <>
            {preview(THEMES.dark)}
            {preview(THEMES.light)}
          </>
        ) : (
          preview(THEMES[id])
        )}
      </div>
      <div className={cx('mt-1.5 truncate text-center text-[12px]', active ? 'text-fg' : 'text-muted')}>{t(`theme.${id}` as Key)}</div>
    </button>
  )
}

function TorznabSection({ settings, save }: { settings: AppSettings; save: (p: Partial<AppSettings>) => void }) {
  const toast = useStore((s) => s.toast)
  const [status, setStatus] = useState<TorznabStatus | null>(null)
  useEffect(() => {
    const t = setTimeout(() => void api.torznabStatus().then(setStatus), 300)
    return () => clearTimeout(t)
  }, [settings.torznabEnabled, settings.torznabPort, settings.torznabApiKey])
  const url = `http://127.0.0.1:${settings.torznabPort}/api/v2.0/indexers/all/results/torznab/`
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    toast({ kind: 'info', text: t('set.copied') })
  }
  const hint = !settings.torznabEnabled
    ? t('set.torznabHint')
    : status?.error
      ? t('set.torznabFailed', { error: status.error })
      : status?.running
        ? t('set.torznabRunning', { port: status.port ?? settings.torznabPort })
        : t('set.torznabHint')
  return (
    <Section title={t('set.section.torznab')}>
      <Row label={t('set.torznab')} hint={hint}>
        <Toggle checked={settings.torznabEnabled} onChange={(v) => save({ torznabEnabled: v })} />
      </Row>
      {settings.torznabEnabled && (
        <>
          <Row label={t('set.torznabPort')}>
            <NumberInput value={settings.torznabPort} min={1024} max={65535} onCommit={(v) => save({ torznabPort: v })} />
          </Row>
          <Row label={t('set.torznabUrl')} hint={t('set.torznabUrlHint')}>
            <div className="flex gap-2">
              <Input readOnly value={url} className="w-72 font-mono text-[12px]" />
              <Button icon={<Copy className="size-4" />} onClick={() => void copy(url)}>
                {t('set.copy')}
              </Button>
            </div>
          </Row>
          <Row label={t('set.torznabKey')}>
            <div className="flex gap-2">
              <Input readOnly value={settings.torznabApiKey} className="w-72 font-mono text-[12px]" />
              <Button icon={<Copy className="size-4" />} onClick={() => void copy(settings.torznabApiKey)}>
                {t('set.copy')}
              </Button>
              <Button
                variant="ghost"
                icon={<KeyRound className="size-4" />}
                onClick={async () => useStore.setState({ settings: await api.regenerateTorznabKey() })}
              >
                {t('set.regenerate')}
              </Button>
            </div>
          </Row>
        </>
      )}
    </Section>
  )
}

function MagnetRow() {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => void api.getMagnetHandler().then(setOn), [])
  return (
    <Row label={t('set.magnet')} hint={t('set.magnetHint')}>
      <Toggle checked={!!on} disabled={on === null} onChange={async (v) => setOn(await api.setMagnetHandler(v))} />
    </Row>
  )
}

function UpdatesRow() {
  const { update, toast } = useStore()
  const [busy, setBusy] = useState(false)
  const version = update?.version ?? ''
  let hint = t('set.updatesHint', { version })
  if (update?.state === 'downloading') hint = t('upd.downloading', { version: update.available ?? '' }) + (update.percent ? ` ${update.percent}%` : '')
  if (update?.state === 'ready') hint = t('upd.ready', { version: update.available ?? '' })
  if (update?.state === 'unsupported') hint = t('upd.devBuild')
  return (
    <Row label={t('set.updates')} hint={hint}>
      {update?.state === 'ready' ? (
        <Button variant="primary" icon={<Download className="size-4" />} onClick={() => void api.installUpdate()}>
          {t('upd.restart')}
        </Button>
      ) : (
        <Button
          icon={<RefreshCw className="size-4" />}
          loading={busy || update?.state === 'checking' || update?.state === 'downloading'}
          onClick={async () => {
            setBusy(true)
            try {
              const s = await api.checkForUpdates()
              useStore.setState({ update: s })
              if (s.state === 'latest') toast({ kind: 'success', text: t('upd.latest') })
              if (s.state === 'error') toast({ kind: 'error', text: t('upd.failed', { error: s.error ?? '' }) })
              if (s.state === 'unsupported') toast({ kind: 'info', text: t('upd.devBuild') })
            } finally {
              setBusy(false)
            }
          }}
        >
          {t('set.checkNow')}
        </Button>
      )}
    </Row>
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
