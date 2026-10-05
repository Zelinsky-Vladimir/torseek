import { categoryName, parentCategory } from '../../core/categories'
import { t, type Key } from './i18n'

// UI-level category groups. Torznab's own top-level split doesn't match how people
// think about content (games live under both Console and PC, anime under TV).

export interface CategoryChip {
  id: string
  label: Key
  match: (cat: number) => boolean
  adult?: boolean
}

export const CATEGORY_CHIPS: CategoryChip[] = [
  { id: 'movies', label: 'cat.movies', match: (c) => parentCategory(c) === 2000 },
  { id: 'tv', label: 'cat.tv', match: (c) => parentCategory(c) === 5000 && c !== 5070 },
  { id: 'anime', label: 'cat.anime', match: (c) => c === 5070 },
  { id: 'music', label: 'cat.music', match: (c) => parentCategory(c) === 3000 },
  { id: 'games', label: 'cat.games', match: (c) => parentCategory(c) === 1000 || c === 4050 },
  { id: 'software', label: 'cat.software', match: (c) => parentCategory(c) === 4000 && c !== 4050 },
  { id: 'books', label: 'cat.books', match: (c) => parentCategory(c) === 7000 },
  { id: 'other', label: 'cat.other', match: (c) => parentCategory(c) === 8000 },
  { id: 'xxx', label: 'cat.xxx', match: (c) => parentCategory(c) === 6000, adult: true },
]

export const isAdult = (cats: number[]) => cats.length > 0 && cats.every((c) => parentCategory(c) === 6000)

/** Localized Torznab name, e.g. "Movies/HD" -> "Фильмы · HD" */
export function localCategoryName(id: number): string | undefined {
  const name = categoryName(id)
  if (!name) return undefined
  const [top, sub] = name.split('/')
  const topLocal = t(`torznab.${top}` as Key)
  return sub ? `${topLocal} · ${sub}` : topLocal
}

/** Short label for a result's category */
export function categoryLabel(cats: number[]): string | undefined {
  const specific = cats.find((c) => c % 1000 !== 0) ?? cats[0]
  return specific == null ? undefined : localCategoryName(specific)
}
