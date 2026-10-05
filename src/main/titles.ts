import type { TitleInfo } from '../shared/api'

// Movie / series info for the search screen, from Cinemeta (Stremio's public catalog,
// IMDb-based, no API key). Only shown when the query clearly names a title: a fuzzy
// "best guess" card for an unrelated movie would be worse than no card.

const BASE = 'https://v3-cinemeta.strem.io/catalog'

interface Meta {
  id: string
  type: 'movie' | 'series'
  name: string
  poster?: string
  releaseInfo?: string
  imdbRating?: string
  genres?: string[]
  description?: string
  popularity?: number
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

const cache = new Map<string, TitleInfo | null>()

export async function lookupTitle(query: string, fetchImpl: typeof fetch = fetch): Promise<TitleInfo | null> {
  const key = normalize(query)
  if (!key || key.length < 2) return null
  if (cache.has(key)) return cache.get(key)!

  // "dune 2021" -> name "dune", year 2021
  const year = /\b(19|20)\d{2}\b/.exec(key)?.[0]
  const name = year ? key.replace(year, '').trim() : key
  if (!name) return null

  const search = async (type: 'movie' | 'series'): Promise<Meta[]> => {
    try {
      const res = await fetchImpl(`${BASE}/${type}/top/search=${encodeURIComponent(name)}.json`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return []
      return (((await res.json()) as { metas?: Meta[] }).metas ?? []).map((m) => ({ ...m, type }))
    } catch {
      return []
    }
  }
  const [movies, series] = await Promise.all([search('movie'), search('series')])

  // Interleave by rank: movie[0], series[0], movie[1], ... Rank (relevance) matters more
  // than an exact name: "dune" should be Dune: Part One (2021), not Dune (1984).
  const ranked: { meta: Meta; rank: number }[] = []
  for (let i = 0; i < 10; i++) {
    if (movies[i]) ranked.push({ meta: movies[i], rank: i })
    if (series[i]) ranked.push({ meta: series[i], rank: i })
  }
  let best: { meta: Meta; score: number } | null = null
  for (const { meta, rank } of ranked) {
    const n = normalize(meta.name)
    let score = n === name ? 50 : n.startsWith(name + ' ') ? 40 : name.startsWith(n + ' ') ? 30 : 0
    if (!score) continue
    if (year) score += meta.releaseInfo?.startsWith(year) ? 50 : -20
    score += -rank * 8 + (meta.popularity ?? 0) * 10
    if (!best || score > best.score) best = { meta, score }
  }

  let info: TitleInfo | null = null
  if (best) {
    // Full meta has rating, genres and description; titles without an IMDb rating are
    // obscure enough that a card would more likely be wrong than helpful
    const full = await fetchImpl(`https://v3-cinemeta.strem.io/meta/${best.meta.type}/${best.meta.id}.json`, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? (r.json() as Promise<{ meta?: Meta }>) : {}))
      .then((j) => (j as { meta?: Meta }).meta)
      .catch(() => undefined)
    const m = { ...best.meta, ...full }
    if (m.imdbRating) {
      info = {
        id: m.id,
        type: best.meta.type,
        name: m.name,
        year: m.releaseInfo,
        poster: m.poster,
        rating: Number(m.imdbRating),
        genres: m.genres?.slice(0, 4),
        description: m.description,
        url: m.id.startsWith('tt') ? `https://www.imdb.com/title/${m.id}/` : undefined,
      }
    }
  }
  cache.set(key, info)
  return info
}
