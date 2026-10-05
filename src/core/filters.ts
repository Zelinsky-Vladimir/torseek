import { parentCategory } from './categories'
import { parseQuality, type Release } from './release'

// Result filters shared by the search UI and background watch checks, so a watched
// search notifies about exactly what the user would have seen on screen.

export type ChipId = 'movies' | 'tv' | 'anime' | 'music' | 'games' | 'software' | 'books' | 'other' | 'xxx'

export const CHIP_MATCHERS: Record<ChipId, (cat: number) => boolean> = {
  movies: (c) => parentCategory(c) === 2000,
  tv: (c) => parentCategory(c) === 5000 && c !== 5070,
  anime: (c) => c === 5070,
  music: (c) => parentCategory(c) === 3000,
  games: (c) => parentCategory(c) === 1000 || c === 4050,
  software: (c) => parentCategory(c) === 4000 && c !== 4050,
  books: (c) => parentCategory(c) === 7000,
  other: (c) => parentCategory(c) === 8000,
  xxx: (c) => parentCategory(c) === 6000,
}

export interface ResultFilters {
  chips?: ChipId[]
  /** '2160p' | '1080p' | '720p' | '480p' */
  resolutions?: string[]
  minSeeds?: number
  showAdult?: boolean
}

export const isAdult = (cats: number[]) => cats.length > 0 && cats.every((c) => parentCategory(c) === 6000)

export function matchesFilters(r: Release, f: ResultFilters, resolution = parseQuality(r.title).resolution): boolean {
  if (!f.showAdult && isAdult(r.categories)) return false
  if (f.chips?.length && !f.chips.some((id) => r.categories.some(CHIP_MATCHERS[id]))) return false
  if (f.resolutions?.length && !f.resolutions.includes(resolution ?? '')) return false
  if (f.minSeeds && (r.seeders ?? 0) < f.minSeeds) return false
  return true
}

const WORD = /[\p{L}\p{N}]+/gu

/** Every word of the query (2+ chars) appears in the title — trackers return loose matches. */
export function titleMatchesQuery(title: string, query: string): boolean {
  const t = title.toLowerCase()
  return (query.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 1).every((w) => t.includes(w))
}
