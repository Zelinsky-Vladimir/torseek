// Date parsing compatible with Jackett's DateTimeUtil. Trackers print dates in every
// format imaginable ("2 hours ago", "Yesterday 14:22", "05.10.2026", "Oct. 5 '26"),
// and definitions rely on these exact behaviours.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'

const monthIndex = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3)))

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)

function parseOffset(tz: string): number | undefined {
  if (/^(z|utc|gmt)$/i.test(tz)) return 0
  const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(tz)
  if (!m) return undefined
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0)
  return m[1] === '-' ? -minutes : minutes
}

interface Parts {
  year?: number
  month?: number // 0-based
  day?: number
  hour?: number
  minute?: number
  second?: number
  ms?: number
  pm?: boolean
  offset?: number // minutes east of UTC
}

function build(p: Parts, now: Date): Date {
  const hasDate = p.year !== undefined || p.month !== undefined || p.day !== undefined
  const year = p.year ?? now.getFullYear()
  const month = p.month ?? (hasDate ? 0 : now.getMonth())
  const day = p.day ?? (hasDate ? 1 : now.getDate())
  let hour = p.hour ?? 0
  if (p.pm !== undefined) {
    if (p.pm && hour < 12) hour += 12
    if (!p.pm && hour === 12) hour = 0
  }
  const [mi, s, ms] = [p.minute ?? 0, p.second ?? 0, p.ms ?? 0]
  if (p.offset !== undefined) return new Date(Date.UTC(year, month, day, hour, mi, s, ms) - p.offset * 60_000)
  return new Date(year, month, day, hour, mi, s, ms)
}

const twoDigitYear = (yy: number) => (yy <= 49 ? 2000 + yy : 1900 + yy)

// --- .NET custom format strings ("yyyy-MM-dd HH:mm zzz") ---------------------------

type Setter = (p: Parts, v: string) => void

const TOKENS: [string, string, Setter][] = [
  ['yyyy', '(\\d{4})', (p, v) => (p.year = Number(v))],
  ['yyy', '(\\d{3,4})', (p, v) => (p.year = Number(v))],
  ['yy', '(\\d{2})', (p, v) => (p.year = twoDigitYear(Number(v)))],
  ['y', '(\\d{1,2})', (p, v) => (p.year = twoDigitYear(Number(v)))],
  ['MMMM', '([a-z]+)', (p, v) => (p.month = monthIndex(v))],
  ['MMM', '([a-z]{3})', (p, v) => (p.month = monthIndex(v))],
  ['MM', '(\\d{2})', (p, v) => (p.month = Number(v) - 1)],
  ['M', '(\\d{1,2})', (p, v) => (p.month = Number(v) - 1)],
  ['dddd', '(?:[a-z]+)', () => {}],
  ['ddd', '(?:[a-z]{3})', () => {}],
  ['dd', '(\\d{2})', (p, v) => (p.day = Number(v))],
  ['d', '(\\d{1,2})', (p, v) => (p.day = Number(v))],
  ['HH', '(\\d{2})', (p, v) => (p.hour = Number(v))],
  ['H', '(\\d{1,2})', (p, v) => (p.hour = Number(v))],
  ['hh', '(\\d{2})', (p, v) => (p.hour = Number(v))],
  ['h', '(\\d{1,2})', (p, v) => (p.hour = Number(v))],
  ['mm', '(\\d{2})', (p, v) => (p.minute = Number(v))],
  ['m', '(\\d{1,2})', (p, v) => (p.minute = Number(v))],
  ['ss', '(\\d{2})', (p, v) => (p.second = Number(v))],
  ['s', '(\\d{1,2})', (p, v) => (p.second = Number(v))],
  ['tt', '(am|pm)', (p, v) => (p.pm = v.toLowerCase() === 'pm')],
  ['t', '(a|p)', (p, v) => (p.pm = v.toLowerCase() === 'p')],
  ['zzz', '([+-]\\d{1,2}(?::?\\d{2})?|z)', (p, v) => (p.offset = parseOffset(v))],
  ['zz', '([+-]\\d{1,2}(?::?\\d{2})?|z)', (p, v) => (p.offset = parseOffset(v))],
  ['z', '([+-]\\d{1,2}(?::?\\d{2})?|z)', (p, v) => (p.offset = parseOffset(v))],
  ['K', '([+-]\\d{1,2}(?::?\\d{2})?|z)?', (p, v) => v && (p.offset = parseOffset(v))],
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const formatCache = new Map<string, { re: RegExp; setters: Setter[] }>()

function compileDotNetFormat(format: string) {
  const cached = formatCache.get(format)
  if (cached) return cached
  let src = ''
  const setters: Setter[] = []
  for (let i = 0; i < format.length; ) {
    const c = format[i]
    if (c === "'" || c === '"') {
      const end = format.indexOf(c, i + 1)
      const lit = format.slice(i + 1, end < 0 ? undefined : end)
      src += escapeRe(lit)
      i = end < 0 ? format.length : end + 1
      continue
    }
    if (c === '\\') {
      src += escapeRe(format[i + 1] ?? '')
      i += 2
      continue
    }
    if (c === '%') {
      i++
      continue
    }
    if (/[fF]/.test(c)) {
      let n = 0
      while (format[i + n] === c) n++
      src += c === 'f' ? `(\\d{${n}})` : `(\\d{0,${n}})`
      setters.push((p, v) => v && (p.ms = Math.round(Number(`0.${v}`) * 1000)))
      i += n
      continue
    }
    if (/\s/.test(c)) {
      while (/\s/.test(format[i] ?? '')) i++
      src += '\\s+'
      continue
    }
    const tok = TOKENS.find(([t]) => format.startsWith(t, i))
    if (tok) {
      src += tok[1]
      setters.push(tok[2])
      i += tok[0].length
      continue
    }
    src += escapeRe(c)
    i++
  }
  const compiled = { re: new RegExp(`^${src}$`, 'i'), setters }
  formatCache.set(format, compiled)
  return compiled
}

export function parseDotNetFormat(input: string, format: string, now = new Date()): Date | undefined {
  const { re, setters } = compileDotNetFormat(format)
  const m = re.exec(input.trim())
  if (!m) return undefined
  const parts: Parts = {}
  setters.forEach((set, i) => set(parts, m[i + 1] ?? ''))
  if (parts.month === -1) return undefined
  const d = build(parts, now)
  return Number.isNaN(d.getTime()) ? undefined : d
}

// --- Go layouts ("2006-01-02 15:04") ----------------------------------------------

/** Same replacement chain as Jackett, which turns a Go layout into a .NET format. */
function goLayoutToDotNet(layout: string): string {
  const pairs: [string, string][] = [
    ['2006', 'yyyy'], ['06', 'yy'],
    ['January', 'MMMM'], ['Jan', 'MMM'], ['01', 'MM'],
    ['Monday', 'dddd'], ['Mon', 'ddd'], ['02', 'dd'], ['2', 'd'],
    ['05', 'ss'], ['15', 'HH'], ['03', 'hh'], ['3', 'h'],
    ['04', 'mm'], ['4', 'm'], ['5', 's'], ['1', 'M'],
    ['.0000', 'ffff'], ['.000', 'fff'], ['.00', 'ff'], ['.0', 'f'],
    ['.9999', 'FFFF'], ['.999', 'FFF'], ['.99', 'FF'], ['.9', 'F'],
    ['PM', 'tt'], ['pm', 'tt'],
    ['Z07:00', "'Z'zzz"], ['Z07', "'Z'zz"], ['-07:00', 'zzz'], ['-07', 'zz'],
  ]
  return pairs.reduce((acc, [from, to]) => acc.split(from).join(to), layout)
}

/** The `dateparse` filter. Accepts .NET formats (what most definitions use) and Go layouts. */
export function parseDateLayout(input: string, layout: string, now = new Date()): Date {
  const date = input.trim()
  if (/[yhd]/i.test(layout)) {
    const direct = parseDotNetFormat(date, layout, now)
    if (direct) return direct
  }
  const format = goLayoutToDotNet(layout)
  const parsed = parseDotNetFormat(date, format, now)
  if (!parsed) throw new Error(`Error while parsing DateTime "${date}", using layout "${layout}" (${format})`)
  if (!format.includes('yy') && parsed > now) parsed.setFullYear(parsed.getFullYear() - 1)
  return parsed
}

// --- relative & fuzzy ---------------------------------------------------------------

/** "2 hours 1 day ago" */
export function fromTimeAgo(input: string, now = new Date()): Date {
  let s = input.toLowerCase()
  if (s.includes('now')) return now
  s = s.replace(/,/g, '').replace(/ago/g, '').replace(/and/g, '')
  let ms = 0
  for (const m of s.matchAll(/\s*?([\d.]+)\s*?([^\d\s.]+)\s*?/g)) {
    const val = Number.parseFloat(m[1]) || 0
    const unit = m[2]
    if (unit.includes('sec') || unit === 's') ms += val * 1000
    else if (unit.includes('min') || unit === 'm') ms += val * 60_000
    else if (unit.includes('hour') || unit.includes('hr') || unit === 'h') ms += val * 3_600_000
    else if (unit.includes('day') || unit === 'd') ms += val * 86_400_000
    else if (unit.includes('week') || unit.includes('wk') || unit === 'w') ms += val * 7 * 86_400_000
    else if (unit.includes('month') || unit === 'mo') ms += val * 30 * 86_400_000
    else if (unit.includes('year') || unit === 'y') ms += val * 365 * 86_400_000
    else throw new Error('TimeAgo parsing failed, unknown unit: ' + unit)
  }
  return new Date(now.getTime() - ms)
}

/** "14:22", "2:30 pm", "14:22:01" -> ms since midnight */
function timeOfDay(input: string): number {
  const s = input.trim()
  if (!s) return 0
  const m = /(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(s)
  if (!m) throw new Error(`Cannot parse time "${s}"`)
  let h = Number(m[1])
  const pm = m[4]?.toLowerCase().startsWith('p')
  if (m[4] && pm && h < 12) h += 12
  if (m[4] && !pm && h === 12) h = 0
  return ((h * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000
}

/** Best-effort parse of a free-form date (DateTimeRoutines replacement). */
export function fromFuzzyTime(input: string, now = new Date()): Date {
  const s = input.trim()
  const parts: Parts = {}
  let found = false

  let m: RegExpExecArray | null
  if ((m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) {
    Object.assign(parts, { year: +m[1], month: +m[2] - 1, day: +m[3] })
    found = true
  } else if ((m = /(\d{1,2})([-/.])(\d{1,2})\2(\d{2,4})/.exec(s))) {
    let [a, b] = [+m[1], +m[3]]
    const year = m[4].length === 2 ? twoDigitYear(+m[4]) : +m[4]
    // US order by default, day-first for dotted dates or when it can't be a month
    const dayFirst = m[2] === '.' || a > 12
    if (dayFirst) [a, b] = [b, a]
    Object.assign(parts, { year, month: a - 1, day: b })
    found = true
  } else if ((m = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+${MONTH_RE}\\.?,?[\\s-]*(\\d{4}|'?\\d{2}(?!:))?`, 'i').exec(s))) {
    Object.assign(parts, { day: +m[1], month: monthIndex(m[2]) })
    if (m[3]) parts.year = m[3].replace("'", '').length === 2 ? twoDigitYear(+m[3].replace("'", '')) : +m[3]
    found = true
  } else if ((m = new RegExp(`${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!:)(?:,?\\s+(\\d{4}|'\\d{2}))?`, 'i').exec(s))) {
    Object.assign(parts, { month: monthIndex(m[1]), day: +m[2] })
    if (m[3]) parts.year = m[3].startsWith("'") ? twoDigitYear(+m[3].slice(1)) : +m[3]
    found = true
  }

  const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(s)
  if (t) {
    Object.assign(parts, { hour: +t[1], minute: +t[2], second: +(t[3] ?? 0) })
    if (t[4]) parts.pm = t[4].toLowerCase().startsWith('p')
    found = true
  }
  const tz = /(?:\s|\d)(z|utc|gmt|[+-]\d{2}:?\d{2})\s*$/i.exec(s)
  if (tz) parts.offset = parseOffset(tz[1])

  if (found) {
    const d = build(parts, now)
    if (!Number.isNaN(d.getTime())) return d
  }
  const native = Date.parse(s)
  if (!Number.isNaN(native)) return new Date(native)
  throw new Error('FromFuzzyTime parsing failed')
}

function fromFuzzyPastTime(input: string, now: Date): Date {
  const d = fromFuzzyTime(input, now)
  if (d > now) d.setFullYear(d.getFullYear() - 1)
  return d
}

const TODAY = /\btoday(?:[\s,]+(?:at)?\s*|[\s,]*|$)/i
const YESTERDAY = /\byesterday(?:[\s,]+(?:at)?\s*|[\s,]*|$)/i
const TOMORROW = /\btomorrow(?:[\s,]+(?:at)?\s*|[\s,]*|$)/i
const DAY_OF_WEEK = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+/i
const MISSING_YEAR = /^(\d{1,2}-\d{1,2})(\s|$)/
const MISSING_YEAR_2 = /^(\d{1,2}\s+\w{3})\s+(\d{1,2}:\d{1,2}.*)$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const RFC2822 = /^[a-z]{3},\s+\d{1,2}\s+[a-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}(:\d{2})?\s+([+-]\d{1,4}|[a-z]{1,4})$/i

/** The `date` field and `fuzzytime` filter: anything goes. */
export function fromUnknown(input: string, now = new Date()): Date {
  const s = input.trim()
  try {
    if (ISO.test(s) || RFC2822.test(s)) {
      const d = new Date(s)
      if (!Number.isNaN(d.getTime())) return d
    }
    if (/^\d+$/.test(s)) {
      const n = Number(s)
      return new Date(n > 1e11 ? n : n * 1000)
    }
    if (s.toLowerCase().includes('now')) return now
    if (/\bago/i.test(s)) return fromTimeAgo(s, now)

    let m: RegExpExecArray | null
    if ((m = TODAY.exec(s))) return new Date(startOfDay(now).getTime() + timeOfDay(s.replace(m[0], '')))
    if ((m = YESTERDAY.exec(s))) return new Date(addDays(startOfDay(now), -1).getTime() + timeOfDay(s.replace(m[0], '')))
    if ((m = TOMORROW.exec(s))) return new Date(addDays(startOfDay(now), 1).getTime() + timeOfDay(s.replace(m[0], '')))
    if ((m = DAY_OF_WEEK.exec(s))) {
      let d = new Date(startOfDay(now).getTime() + timeOfDay(s.replace(m[0], '')))
      const dow = DAYS.indexOf(m[1].toLowerCase())
      while (d.getDay() !== dow) d = addDays(d, -1)
      return d
    }
    if ((m = MISSING_YEAR.exec(s))) return fromFuzzyPastTime(s.replace(m[1], `${now.getFullYear()}-${m[1]}`), now)
    if ((m = MISSING_YEAR_2.exec(s))) return fromFuzzyPastTime(`${m[1]} ${now.getFullYear()} ${m[2]}`, now)
    return fromFuzzyTime(s, now)
  } catch (e) {
    throw new Error(`DateTime parsing failed for "${s}": ${(e as Error).message}`)
  }
}
