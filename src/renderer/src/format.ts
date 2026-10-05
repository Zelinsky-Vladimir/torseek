export function formatBytes(n: number | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : digits)} ${units[i]}`
}

export const formatSpeed = (bps: number) => (bps > 0 ? `${formatBytes(bps)}/s` : '—')

export function formatAge(iso: string | undefined): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff)) return '—'
  const min = diff / 60_000
  if (min < 60) return `${Math.max(1, Math.round(min))}m`
  const h = min / 60
  if (h < 24) return `${Math.round(h)}h`
  const d = h / 24
  if (d < 30) return `${Math.round(d)}d`
  if (d < 365) return `${Math.round(d / 30)}mo`
  return `${(d / 365).toFixed(d < 3650 ? 1 : 0)}y`
}

export function formatEta(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.round(h / 24)}d`
}

export const formatCount = (n: number | undefined) =>
  n == null ? '—' : n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')
