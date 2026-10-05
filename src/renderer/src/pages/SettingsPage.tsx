import { useEffect, useState, type ReactNode } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import type { AppSettings, DefinitionsStatus } from '../../../shared/api'
import { api } from '../api'
import { errorText, useStore } from '../store'
import { Button, Input, Toggle } from '../ui'

export function SettingsPage() {
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  const save = (patch: Partial<AppSettings>) => void saveSettings(patch)

  return (
    <div className="flex h-full flex-col">
      <div className="drag border-b border-line/70 px-6 pb-3 pt-3.5">
        <h1 className="text-[17px] font-semibold">Settings</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-2xl space-y-8">
          <Section title="Downloads">
            <Row label="Save to" hint="New torrents are downloaded into this folder.">
              <div className="flex gap-2">
                <Input readOnly value={settings.downloadDir} className="flex-1" />
                <Button
                  icon={<FolderOpen className="size-4" />}
                  onClick={async () => {
                    const dir = await api.chooseDownloadDir()
                    if (dir) useStore.setState({ settings: { ...settings, downloadDir: dir } })
                  }}
                >
                  Change
                </Button>
              </div>
            </Row>
            <Row label="Keep seeding" hint="Continue uploading after a download completes. Good for ratio and for the swarm.">
              <Toggle checked={settings.seedAfterDownload} onChange={(v) => save({ seedAfterDownload: v })} />
            </Row>
            <Row label="Download limit" hint="KB/s, 0 for unlimited">
              <NumberInput value={settings.downloadLimit} onCommit={(v) => save({ downloadLimit: v })} />
            </Row>
            <Row label="Upload limit" hint="KB/s, 0 for unlimited">
              <NumberInput value={settings.uploadLimit} onCommit={(v) => save({ uploadLimit: v })} />
            </Row>
          </Section>

          <Section title="Search">
            <Row label="Parallel trackers" hint="How many sites are queried at the same time.">
              <NumberInput value={settings.searchConcurrency} min={1} max={64} onCommit={(v) => save({ searchConcurrency: v })} />
            </Row>
            <Row label="Tracker timeout" hint="Seconds to wait for a slow site before giving up on it.">
              <NumberInput value={settings.searchTimeoutSec} min={5} max={120} onCommit={(v) => save({ searchTimeoutSec: v })} />
            </Row>
            <Row label="Show adult content" hint="Show the XXX category and results that are only in it.">
              <Toggle checked={settings.showAdult} onChange={(v) => save({ showAdult: v })} />
            </Row>
          </Section>

          <Section title="Trackers">
            <DefinitionsRow />
          </Section>

          <Section title="About">
            <p className="text-[13px] leading-relaxed text-muted">
              Torseek runs the community-maintained Cardigann tracker definitions from the Jackett project (GPL-2.0). Drop updated or custom
              <code className="mx-1 rounded bg-panel-2 px-1 py-0.5 text-[12px]">.yml</code>
              definitions into the <code className="rounded bg-panel-2 px-1 py-0.5 text-[12px]">definitions</code> folder inside the app data directory to override the bundled ones.
            </p>
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

  const hint = status?.checkedAt
    ? `Last updated ${new Date(status.checkedAt).toLocaleString()}. Checked automatically once a day.`
    : 'Not updated yet; the definitions bundled with the app are used. Checked automatically once a day.'

  return (
    <Row label="Tracker definitions" hint={hint}>
      <Button
        icon={<RefreshCw className="size-4" />}
        loading={busy || status?.updating}
        onClick={async () => {
          setBusy(true)
          try {
            const s = await api.updateDefinitions()
            setStatus({ ...s })
            if (s.error) toast({ kind: 'error', text: `Update failed: ${s.error}` })
            else {
              const r = s.lastResult!
              const changed = r.updated + r.added + r.removed
              toast({ kind: 'success', text: changed ? `${r.updated} updated, ${r.added} new, ${r.removed} removed` : 'All tracker definitions are up to date' })
            }
          } catch (e) {
            toast({ kind: 'error', text: errorText(e) })
          } finally {
            setBusy(false)
          }
        }}
      >
        Update now
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
