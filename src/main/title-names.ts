// The name of a movie / series in other languages, so "дюна" also finds releases
// called "Dune" (and "Dune" finds "Дюна" on Russian trackers). Wikidata has titles in
// every language, needs no key, and its full-text search covers labels and aliases in
// all of them. We only use a hit whose label or alias equals the query: expanding
// "linux mint" into some film's title would just add noise.

const API = 'https://www.wikidata.org/w/api.php'
const UA = 'Torseek (https://github.com/Zelinsky-Vladimir/torseek)'

// film, TV series, animated film, anime series, miniseries, anime film, animated series, TV program
const WORKS = ['Q11424', 'Q5398426', 'Q202866', 'Q63952888', 'Q1259759', 'Q20650540', 'Q581714', 'Q15416']
  .map((q) => `P31=${q}`)
  .join('|')

export interface TitleNames {
  /** Wikidata language code -> title */
  names: Record<string, string>
  /** Words after the title kept for every variant: "dune 2021 2160p" -> "2021 2160p" */
  suffix: string
}

export const normalizeTitle = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

// Year, resolution, season/episode at the end of a query aren't part of the title
const EXTRA = /^((19|20)\d\d|\d{3,4}p|4k|uhd|s\d{1,2}(e\d{1,3})?|e\d{1,3})$/i

export function splitQuery(query: string): { title: string; suffix: string } {
  const words = query.trim().split(/\s+/)
  let i = words.length
  while (i > 1 && EXTRA.test(words[i - 1])) i--
  return { title: words.slice(0, i).join(' '), suffix: words.slice(i).join(' ') }
}

/** Title as a search keyword: punctuation that trackers choke on becomes a space */
const asKeyword = (label: string) => label.replace(/[:·–—/\\|]+/g, ' ').replace(/\s+/g, ' ').trim()

// Chinese labels are split by script / region on Wikidata
const LANG_FALLBACK: Record<string, string[]> = {
  zh: ['zh', 'zh-hans', 'zh-cn', 'zh-hant', 'zh-tw'],
  'zh-tw': ['zh-tw', 'zh-hant', 'zh', 'zh-hk'],
  'zh-hk': ['zh-hk', 'zh-hant', 'zh-tw', 'zh'],
  pt: ['pt', 'pt-br'],
  'pt-br': ['pt-br', 'pt'],
}

/** The title for a tracker language like "ru-RU" or "zh-TW"; English when the language has none */
export function nameFor(names: Record<string, string>, language: string | undefined): string | undefined {
  const full = (language ?? 'en').toLowerCase()
  const base = full.split('-')[0]
  for (const code of [...(LANG_FALLBACK[full] ?? [full]), ...(LANG_FALLBACK[base] ?? [base]), 'en']) if (names[code]) return names[code]
  return undefined
}

const cache = new Map<string, TitleNames | null>()

export async function findTitleNames(query: string, fetchImpl: typeof fetch = fetch): Promise<TitleNames | null> {
  const { title, suffix } = splitQuery(query)
  const key = normalizeTitle(title)
  if (key.length < 2 || /^\d+$/.test(key)) return null
  if (cache.has(key)) return withSuffix(cache.get(key)!, suffix)

  const get = async (params: Record<string, string>) => {
    const url = new URL(API)
    for (const [k, v] of Object.entries({ ...params, format: 'json', origin: '*' })) url.searchParams.set(k, v)
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`Wikidata: ${res.status}`)
    return res.json()
  }

  const found = (await get({ action: 'query', list: 'search', srsearch: `${title} haswbstatement:${WORKS}`, srlimit: '5', srprop: '' })) as {
    query?: { search: { title: string }[] }
  }
  const ids = (found.query?.search ?? []).map((s) => s.title)
  let result: TitleNames | null = null
  if (ids.length) {
    const { entities } = (await get({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels|aliases' })) as {
      entities: Record<string, { labels?: Record<string, { value: string }>; aliases?: Record<string, { value: string }[]> }>
    }
    // Search order is relevance; take the first work actually named like the query
    for (const id of ids) {
      const e = entities[id]
      if (!e?.labels) continue
      const all = [...Object.values(e.labels).map((l) => l.value), ...Object.values(e.aliases ?? {}).flatMap((a) => a.map((x) => x.value))]
      if (!all.some((n) => normalizeTitle(n) === key)) continue
      result = { names: Object.fromEntries(Object.entries(e.labels).map(([lang, l]) => [lang, asKeyword(l.value)])), suffix: '' }
      break
    }
  }
  if (cache.size > 300) cache.delete(cache.keys().next().value!)
  cache.set(key, result)
  return withSuffix(result, suffix)
}

const withSuffix = (r: TitleNames | null, suffix: string): TitleNames | null => (r ? { ...r, suffix } : null)

/** Extra keywords for a tracker: the title in its language, unless that's what was typed */
export function variantFor(names: TitleNames, language: string | undefined, query: string): string | undefined {
  const name = nameFor(names.names, language)
  if (!name) return undefined
  const variant = [name, names.suffix].filter(Boolean).join(' ')
  return normalizeTitle(variant) === normalizeTitle(query) ? undefined : variant
}
