import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, CheckCircle2, CircleAlert, Download, Info, Library, Search, Server, Settings, X } from 'lucide-react'
import { LibraryPage } from './pages/LibraryPage'
import { api, isMock } from './api'
import { cx, formatSpeed } from './format'
import { DownloadsPage } from './pages/DownloadsPage'
import { SearchPage } from './pages/SearchPage'
import { SettingsPage } from './pages/SettingsPage'
import { TrackersPage } from './pages/TrackersPage'
import { useStore, type Page } from './store'
import { t, t as tr } from './i18n'

export function App() {
  const page = useStore((s) => s.page)
  // Remount on language change so every t() call re-runs
  const lang = useStore((s) => s.lang)
  return (
    <div key={lang} className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 bg-bg">
        {page === 'search' && <SearchPage />}
        {page === 'downloads' && <DownloadsPage />}
        {page === 'library' && <LibraryPage />}
        {page === 'trackers' && <TrackersPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
      <Toasts />
    </div>
  )
}

function Sidebar() {
  const { page, setPage, torrents, indexers, update, watches } = useStore()
  const newHits = watches.reduce((s, w) => s + w.newCount, 0)
  const active = torrents.filter((t) => t.state === 'downloading' || t.state === 'metadata').length
  const down = torrents.reduce((s, t) => s + t.downloadSpeed, 0)
  const up = torrents.reduce((s, t) => s + t.uploadSpeed, 0)
  const enabled = indexers.filter((i) => i.enabled).length

  return (
    <aside className="drag flex w-[212px] shrink-0 flex-col border-r border-line/70 bg-panel/60 px-3 pb-3 pt-3">
      <div className="flex items-center gap-2.5 px-2 pb-5 pt-1">
        <div className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent-2 shadow-md shadow-accent/30">
          <Search className="size-3.5 text-white" strokeWidth={3} />
        </div>
        <span className="text-[15px] font-semibold tracking-tight">Torseek</span>
        {isMock && <span className="rounded bg-warn/15 px-1.5 text-[10px] font-semibold text-warn">MOCK</span>}
      </div>
      <nav className="no-drag space-y-0.5">
        <NavItem page="search" current={page} onClick={setPage} icon={<Search className="size-4" />}>
          {t('nav.search')}
        </NavItem>
        <NavItem page="downloads" current={page} onClick={setPage} icon={<Download className="size-4" />} badge={active || undefined}>
          {t('nav.downloads')}
        </NavItem>
        <NavItem page="library" current={page} onClick={setPage} icon={<Library className="size-4" />} badge={newHits || undefined}>
          {t('nav.library')}
        </NavItem>
        <NavItem page="trackers" current={page} onClick={setPage} icon={<Server className="size-4" />} hint={String(enabled)}>
          {t('nav.trackers')}
        </NavItem>
        <NavItem page="settings" current={page} onClick={setPage} icon={<Settings className="size-4" />}>
          {t('nav.settings')}
        </NavItem>
      </nav>
      {update?.state === 'ready' && (
        <div className="no-drag mt-auto mb-2 rounded-lg border border-accent/40 bg-accent/10 p-2.5 text-[12px]">
          <div className="leading-snug text-fg">{t('upd.ready', { version: update.available ?? '' })}</div>
          <button onClick={() => void api.installUpdate()} className="mt-2 w-full rounded-md bg-accent-2 py-1 font-semibold text-white hover:bg-accent">
            {t('upd.restart')}
          </button>
        </div>
      )}
      <div className={cx('space-y-1 rounded-lg px-2 py-2 text-[12px] tabular-nums text-muted', update?.state !== 'ready' && 'mt-auto')}>
        <div className="flex items-center gap-1.5">
          <ArrowDown className="size-3.5 text-accent" />
          {formatSpeed(down)}
        </div>
        <div className="flex items-center gap-1.5">
          <ArrowUp className="size-3.5 text-good" />
          {formatSpeed(up)}
        </div>
      </div>
    </aside>
  )
}

function NavItem({
  page,
  current,
  onClick,
  icon,
  children,
  badge,
  hint,
}: {
  page: Page
  current: Page
  onClick: (p: Page) => void
  icon: ReactNode
  children: ReactNode
  badge?: number
  hint?: string
}) {
  const active = page === current
  return (
    <button
      onClick={() => onClick(page)}
      className={cx(
        'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors',
        active ? 'bg-hover text-fg' : 'text-muted hover:bg-hover/60 hover:text-fg',
      )}
    >
      <span className={active ? 'text-accent' : ''}>{icon}</span>
      {children}
      {badge != null && <span className="ml-auto rounded-full bg-accent-2 px-1.5 text-[11px] font-semibold leading-[18px] text-white">{badge}</span>}
      {hint != null && badge == null && <span className="ml-auto text-[12px] tabular-nums text-faint">{hint}</span>}
    </button>
  )
}

function Toasts() {
  const { toasts, dismissToast } = useStore()
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[380px] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="animate-toast pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-panel-2 px-3.5 py-3 text-[13px] shadow-2xl shadow-black/40">
          {t.kind === 'success' ? (
            <CheckCircle2 className="mt-px size-4 shrink-0 text-good" />
          ) : t.kind === 'error' ? (
            <CircleAlert className="mt-px size-4 shrink-0 text-bad" />
          ) : (
            <Info className="mt-px size-4 shrink-0 text-accent" />
          )}
          <div className="min-w-0 flex-1 leading-snug selectable">{t.text}</div>
          {t.action && (
            <button
              className="shrink-0 font-semibold text-accent hover:text-fg"
              onClick={() => {
                t.action!.run()
                dismissToast(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="shrink-0 text-faint hover:text-fg" onClick={() => dismissToast(t.id)} aria-label={tr('common.dismiss')}>
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
