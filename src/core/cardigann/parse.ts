// Number/size helpers, ported from Jackett's ParseUtil so values parse identically.

export const normalizeSpace = (s: string | null | undefined) => (s ?? '').trim()

function normalizeNumber(s: string, isInt: boolean): string {
  let v = [...s].filter((c) => /[\d.,]/.test(c)).join('').trim()
  if (isInt) {
    if (v.includes(',') && v.includes('.')) {
      // "1,234.00" -> treat the last separator as the decimal point
      const last = Math.max(v.lastIndexOf(','), v.lastIndexOf('.'))
      return v.slice(0, last).replace(/[.,]/g, '') || '0'
    }
    return v.replace(/[.,]/g, '') || '0'
  }
  v = v.length === 0 ? '0' : v.replace(/,/g, '.')
  const dots = v.split('.').length - 1
  if (dots > 1) {
    const last = v.lastIndexOf('.')
    v = v.slice(0, last).replace(/\./g, '') + v.slice(last)
  }
  return v
}

export const coerceDouble = (s: string) => Number.parseFloat(normalizeNumber(s, false)) || 0
export const coerceLong = (s: string) => Number.parseInt(normalizeNumber(s, true), 10) || 0

/** First run of digits in a string: "tt0123456" -> 123456 */
export function getLongFromString(s: string | null | undefined): number | undefined {
  if (!s?.trim()) return undefined
  const m = /\d+/.exec(s)
  return m ? Number.parseInt(m[0], 10) : 0
}

const CYRILLIC_UNITS: Record<string, string> = { кб: 'kb', мб: 'mb', гб: 'gb', тб: 'tb' }

/** " 3.5  gb " -> 3758096384, "1.018,29 MB" -> 1067754455 */
export function getBytes(s: string): number {
  let v = [...s].filter((c) => /[\d.,]/.test(c)).join('')
  v = v.length === 0 ? '0' : v.replace(/,/g, '.')
  if (v.split('.').length - 1 > 1) {
    const last = v.lastIndexOf('.')
    v = v.slice(0, last).replace(/\./g, '') + v.slice(last)
  }
  let unit = [...s].filter((c) => /\p{L}/u.test(c)).join('').replace(/i/g, '').toLowerCase()
  for (const [cyr, lat] of Object.entries(CYRILLIC_UNITS)) unit = unit.replace(cyr, lat)
  const value = coerceDouble(v)
  const pow = unit.includes('kb') ? 1 : unit.includes('mb') ? 2 : unit.includes('gb') ? 3 : unit.includes('tb') ? 4 : 0
  return Math.floor(value * 1024 ** pow)
}

/** Value of `arg` in the query string of `url` (accepts bare query strings too). */
export function queryStringArg(url: string, arg: string): string {
  const qs = url.includes('?') ? url.split('?', 2)[1] : url
  return new URLSearchParams(qs.split('#')[0]).get(arg) ?? ''
}
