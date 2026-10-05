import { useEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, ChevronRight, Globe, KeyRound, Lock, LogIn, LogOut, Search, Server, ShieldCheck } from 'lucide-react'
import { localCategoryName } from '../categories'
import { t, tn, translateError, type Key } from '../i18n'
import type { IndexerInfo, IndexerSettings, SettingsField } from '../../../shared/api'
import { api } from '../api'
import { cx } from '../format'
import { errorText, useStore } from '../store'
import { Badge, Button, EmptyState, Input, Toggle } from '../ui'

type Filter = 'enabled' | 'public' | 'accounts' | 'problems' | 'all'

const FILTERS: { id: Filter; label: Key }[] = [
  { id: 'enabled', label: 'tr.filter.enabled' },
  { id: 'public', label: 'tr.filter.public' },
  { id: 'accounts', label: 'tr.filter.accounts' },
  { id: 'problems', label: 'tr.filter.problems' },
  { id: 'all', label: 'tr.filter.all' },
]

const matches = (i: IndexerInfo, f: Filter) =>
  f === 'enabled'
    ? i.enabled
    : f === 'public'
      ? i.type === 'public'
      : f === 'accounts'
        ? i.type !== 'public'
        : f === 'problems'
          ? i.enabled && !!i.health && i.health.state !== 'done'
          : true

const langOf = (i: IndexerInfo) => (i.language ?? 'other').split('-')[0].toLowerCase()

export function TrackersPage() {
  const { indexers, focusTracker } = useStore()
  const [filter, setFilter] = useState<Filter>(focusTracker ? 'all' : 'enabled')
  const [lang, setLang] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(focusTracker ?? null)

  useEffect(() => {
    if (focusTracker) {
      setOpen(focusTracker)
      setFilter('all')
      useStore.setState({ focusTracker: undefined })
    }
  }, [focusTracker])

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, indexers.filter((i) => matches(i, f.id)).length])), [indexers])
  const languages = useMemo(() => {
    const c = new Map<string, number>()
    for (const i of indexers) c.set(langOf(i), (c.get(langOf(i)) ?? 0) + 1)
    return [...c].sort((a, b) => b[1] - a[1])
  }, [indexers])

  const shown = indexers.filter((i) => {
    if (q && !`${i.name} ${i.description ?? ''}`.toLowerCase().includes(q.toLowerCase())) return false
    if (lang && langOf(i) !== lang) return false
    return matches(i, filter)
  })

  return (
    <div className="flex h-full flex-col">
      <div className="drag flex items-center gap-4 border-b border-line/70 px-6 pb-3 pt-3.5">
        <h1 className="text-[17px] font-semibold">{t('tr.title')}</h1>
        <div className="no-drag flex items-center gap-1 rounded-lg bg-panel p-0.5 text-[12.5px]">
          {FILTERS.map((f) => (
            <button key={f.id} onClick={() => setFilter(f.id)} className={cx('whitespace-nowrap rounded-md px-2.5 py-1', filter === f.id ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}>
              {t(f.label)} <span className="tabular-nums text-faint">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          className="no-drag h-8 rounded-lg border border-line bg-panel px-2 text-[12.5px] text-muted outline-none"
        >
          <option value="">{t('tr.allLanguages')}</option>
          {languages.map(([l, n]) => (
            <option key={l} value={l}>
              {l.toUpperCase()} ({n})
            </option>
          ))}
        </select>
        <div className="no-drag relative mr-[140px] ml-auto w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('tr.filterPlaceholder')} className="w-full pl-9" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {shown.length === 0 ? (
          <EmptyState icon={<Server className="size-6" />} title={t('tr.emptyTitle')}>
            {filter === 'problems' ? t('tr.emptyProblems') : t('tr.emptyOther')}
          </EmptyState>
        ) : (
          shown.slice(0, 300).map((ix) => <TrackerRow key={ix.id} ix={ix} open={open === ix.id} onToggleOpen={() => setOpen(open === ix.id ? null : ix.id)} />)
        )}
      </div>
    </div>
  )
}

function HealthDot({ ix }: { ix: IndexerInfo }) {
  const h = ix.health
  if (!h) return <span className="text-[12px] text-faint">{ix.loginMethod && !ix.signedIn ? t('tr.health.notSignedIn') : t('tr.health.notChecked')}</span>
  const label =
    h.state === 'done'
      ? tn('tr.health.results', h.count ?? 0)
      : h.state === 'blocked'
        ? t('tr.health.protected')
        : h.state === 'auth'
          ? t('tr.health.auth')
          : h.state === 'timeout'
            ? t('tr.health.timeout')
            : t('tr.health.error')
  const color = h.state === 'done' ? ((h.count ?? 0) > 0 ? 'bg-good' : 'bg-faint') : h.state === 'error' ? 'bg-bad' : 'bg-warn'
  return (
    <span className="flex items-center justify-end gap-1.5 text-[12px] text-muted" title={h.error ? translateError(h.error) : undefined}>
      <span className={cx('size-1.5 rounded-full', color)} />
      {label}
    </span>
  )
}

function TrackerRow({ ix, open, onToggleOpen }: { ix: IndexerInfo; open: boolean; onToggleOpen: () => void }) {
  const { patchIndexer, toast, passChallenge } = useStore()
  const [testing, setTesting] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const configurable = ix.settings.some((s) => !s.type?.startsWith('info')) || ix.links.length > 1

  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [open])

  const toggle = async (v: boolean) => {
    patchIndexer(await api.setIndexerEnabled(ix.id, v))
    if (v && ix.loginMethod && !ix.signedIn && !open) onToggleOpen()
  }

  return (
    <div ref={ref} className={cx('rounded-xl', open && 'bg-panel')}>
      <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-panel">
        <Toggle checked={ix.enabled} disabled={!!ix.unsupported} label={t('tr.enable', { name: ix.name })} onChange={(v) => void toggle(v)} />
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onToggleOpen}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13.5px] font-medium">{ix.name}</span>
              {ix.language && <Badge>{ix.language.split('-')[0].toUpperCase()}</Badge>}
              {ix.type !== 'public' && (
                <Badge tone="warn">
                  <Lock className="mr-1 size-2.5" />
                  {t(`tr.type.${ix.type}` as Key) ?? ix.type}
                </Badge>
              )}
              {ix.signedIn && (
                <Badge tone="good">
                  <ShieldCheck className="mr-1 size-2.5" />
                  {t('tr.signedIn')}
                </Badge>
              )}
            </div>
            <div className="mt-0.5 truncate text-[12px] text-muted">{ix.unsupported ? t('tr.unsupported', { reason: ix.unsupported }) : ix.description}</div>
          </div>
          <div className="hidden w-56 flex-wrap justify-end gap-x-2 lg:flex">
            {ix.categories.slice(0, 4).map((c) => (
              <span key={c} className="text-[11.5px] text-faint">
                {localCategoryName(c)}
              </span>
            ))}
          </div>
          <div className="w-28 text-right">
            <HealthDot ix={ix} />
          </div>
          <ChevronRight className={cx('size-4 text-faint transition-transform', open && 'rotate-90')} />
        </button>
      </div>

      {open && (
        <div className="space-y-4 px-14 pb-4 pt-1">
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
            <Globe className="size-3.5" />
            <button className="hover:text-fg hover:underline" onClick={() => void api.openExternal(ix.siteLink)}>
              {ix.siteLink}
            </button>
          </div>
          {ix.health?.error && <div className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[12.5px] text-bad selectable">{translateError(ix.health.error)}</div>}
          {ix.health?.state === 'blocked' && (
            <div className="flex items-center gap-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[12.5px] text-warn">
              <span className="flex-1">{t('tr.blocked')}</span>
              <Button size="sm" icon={<AppWindow className="size-3.5" />} onClick={() => void passChallenge(ix.id, ix.name)}>
                {t('tr.openSite')}
              </Button>
            </div>
          )}
          {ix.loginMethod && <AccountSection ix={ix} />}
          {configurable && <SettingsForm ix={ix} />}
          <InfoNotes ix={ix} />
          <div className="flex gap-2">
            <Button
              size="sm"
              loading={testing}
              onClick={async () => {
                setTesting(true)
                try {
                  const info = await api.testIndexer(ix.id)
                  patchIndexer(info)
                  const h = info.health
                  toast({ kind: h?.state === 'done' ? 'success' : 'error', text: `${ix.name}: ${h?.state === 'done' ? tn('tr.health.results', h.count ?? 0) : translateError(h?.error ?? h?.state ?? '')}` })
                } catch (e) {
                  toast({ kind: 'error', text: errorText(e) })
                } finally {
                  setTesting(false)
                }
              }}
            >
              {t('tr.test')}
            </Button>
            {!ix.health || ix.health.state !== 'blocked' ? (
              <Button size="sm" variant="ghost" icon={<AppWindow className="size-3.5" />} onClick={() => void passChallenge(ix.id, ix.name)}>
                {t('tr.openInApp')}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

function AccountSection({ ix }: { ix: IndexerInfo }) {
  const { patchIndexer, toast } = useStore()
  const [busy, setBusy] = useState<'form' | 'browser' | 'out' | null>(null)
  const hasCredentials = ix.settings.some((f) => f.name === 'username' || f.name === 'password')
  const credentialsSaved = ['username', 'password'].every((n) => !ix.settings.some((f) => f.name === n) || !!ix.values[n])

  const run = async (kind: 'form' | 'browser') => {
    setBusy(kind)
    try {
      const res = kind === 'form' ? await api.signIn(ix.id) : await api.signInWithBrowser(ix.id)
      patchIndexer(res.info)
      toast(res.ok ? { kind: 'success', text: res.message ? translateError(res.message) : t('tr.account.ok', { name: ix.name }) } : { kind: 'error', text: `${ix.name}: ${translateError(res.message ?? '')}` })
    } catch (e) {
      toast({ kind: 'error', text: errorText(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2.5">
      <KeyRound className="size-4 text-muted" />
      <div className="flex-1 text-[12.5px]">
        {ix.signedIn ? (
          <span className="text-good">{t('tr.account.signedIn')}</span>
        ) : (
          <span className="text-muted">
            {t('tr.account.needs')} {hasCredentials ? t('tr.account.hintCredentials') : t('tr.account.hintBrowser')}
          </span>
        )}
      </div>
      {hasCredentials && !ix.signedIn && (
        <Button
          size="sm"
          variant="primary"
          loading={busy === 'form'}
          disabled={!credentialsSaved}
          title={credentialsSaved ? undefined : t('tr.account.saveFirst')}
          icon={<LogIn className="size-3.5" />}
          onClick={() => void run('form')}
        >
          {t('tr.account.signIn')}
        </Button>
      )}
      <Button size="sm" loading={busy === 'browser'} icon={<AppWindow className="size-3.5" />} onClick={() => void run('browser')}>
        {ix.signedIn ? t('tr.openSite') : t('tr.account.signInBrowser')}
      </Button>
      {ix.signedIn && (
        <Button
          size="sm"
          variant="ghost"
          loading={busy === 'out'}
          icon={<LogOut className="size-3.5" />}
          onClick={async () => {
            setBusy('out')
            patchIndexer(await api.signOut(ix.id))
            setBusy(null)
          }}
        >
          {t('tr.account.signOut')}
        </Button>
      )}
    </div>
  )
}

// `info` settings carry hints from the definition (HTML); the Jackett-specific ones
// (FlareSolverr, how to copy a cookie) don't apply here.
const SKIP_INFO = new Set(['info_flaresolverr', 'info_cookie', 'info_useragent', 'info_category_8000'])

function InfoNotes({ ix }: { ix: IndexerInfo }) {
  const notes = ix.settings.filter((f) => f.type === 'info' && !SKIP_INFO.has(f.name) && f.default)
  if (!notes.length) return null
  return (
    <div className="space-y-1.5">
      {notes.map((n) => (
        <p key={n.name} className="text-[12px] leading-relaxed text-faint">
          {n.label && <span className="text-muted">{n.label}: </span>}
          {String(n.default)
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, '')}
        </p>
      ))}
    </div>
  )
}

function SettingsForm({ ix }: { ix: IndexerInfo }) {
  const { patchIndexer, toast } = useStore()
  const [values, setValues] = useState<IndexerSettings>(ix.values)
  const dirty = JSON.stringify(values) !== JSON.stringify(ix.values)
  const valueOf = (f: SettingsField) => values[f.name] ?? (f.type === 'multi-select' ? (f.defaults ?? []) : (f.default ?? ''))
  const set = (name: string, v: IndexerSettings[string]) => setValues({ ...values, [name]: v })

  const fields = ix.settings.filter((f) => !f.type?.startsWith('info'))
  // Common credential fields get localized labels; the rest keep the definition's text
  const KNOWN = ['username', 'password', 'cookie', 'apikey', 'passkey']
  const labelOf = (f: SettingsField) => (KNOWN.includes(f.name) ? t(`tr.field.${f.name}` as Key) : (f.label ?? f.name))

  return (
    <div className="space-y-3">
      {ix.links.length > 1 && (
        <Field label={t('tr.mirror')}>
          <select
            value={String(values.sitelink ?? ix.links[0])}
            onChange={(e) => set('sitelink', e.target.value)}
            className="h-8 w-full max-w-md rounded-lg border border-line bg-panel-2 px-2 text-[13px] outline-none"
          >
            {ix.links.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      )}
      {fields.map((f) => (
        <Field key={f.name} label={labelOf(f)}>
          {f.type === 'checkbox' ? (
            <Toggle checked={valueOf(f) === true || valueOf(f) === 'true'} onChange={(v) => set(f.name, v)} />
          ) : f.type === 'select' ? (
            <select
              value={String(valueOf(f))}
              onChange={(e) => set(f.name, e.target.value)}
              className="h-8 w-full max-w-md rounded-lg border border-line bg-panel-2 px-2 text-[13px] outline-none"
            >
              {Object.entries(f.options ?? {}).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          ) : f.type === 'multi-select' ? (
            <div className="flex max-w-xl flex-wrap gap-x-4 gap-y-1.5">
              {Object.entries(f.options ?? {}).map(([k, label]) => {
                const list = (valueOf(f) as string[]) ?? []
                return (
                  <label key={k} className="flex items-center gap-1.5 text-[12.5px] text-muted">
                    <input type="checkbox" checked={list.includes(k)} onChange={(e) => set(f.name, e.target.checked ? [...list, k] : list.filter((x) => x !== k))} />
                    {label}
                  </label>
                )
              })}
            </div>
          ) : (
            <Input
              type={f.type === 'password' ? 'password' : 'text'}
              value={String(valueOf(f))}
              onChange={(e) => set(f.name, e.target.value)}
              autoComplete="off"
              className="h-8 w-full max-w-md"
            />
          )}
        </Field>
      ))}
      {dirty && (
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              patchIndexer(await api.updateIndexerSettings(ix.id, values))
              toast({ kind: 'success', text: t('tr.saved', { name: ix.name }) })
            } catch (e) {
              toast({ kind: 'error', text: errorText(e) })
            }
          }}
        >
          {t('tr.save')}
        </Button>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[220px_1fr] items-center gap-4">
      <div className="text-[12.5px] leading-snug text-muted">{label}</div>
      <div>{children}</div>
    </div>
  )
}
