import { t } from './i18n'

export function formatBytes(n: number | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—'
  const units = [t('unit.B'), t('unit.KB'), t('unit.MB'), t('unit.GB'), t('unit.TB')]
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : digits)} ${units[i]}`
}

export const formatSpeed = (bps: number) => (bps > 0 ? `${formatBytes(bps)}${t('unit.perSec')}` : '—')

export function formatAge(iso: string | undefined): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff)) return '—'
  const min = diff / 60_000
  if (min < 60) return `${Math.max(1, Math.round(min))} ${t('unit.min')}`
  const h = min / 60
  if (h < 24) return `${Math.round(h)} ${t('unit.hour')}`
  const d = h / 24
  if (d < 30) return `${Math.round(d)} ${t('unit.day')}`
  if (d < 365) return `${Math.round(d / 30)} ${t('unit.month')}`
  return `${(d / 365).toFixed(d < 3650 ? 1 : 0)} ${t('unit.year')}`
}

export function formatEta(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} ${t('unit.sec')}`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} ${t('unit.min')}`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} ${t('unit.hour')} ${m % 60} ${t('unit.min')}`
  return `${Math.round(h / 24)} ${t('unit.day')}`
}

export const formatCount = (n: number | undefined) =>
  n == null ? '—' : n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')
