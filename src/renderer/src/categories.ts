import { categoryName, parentCategory } from '../../core/categories'

// UI-level category groups. Torznab's own top-level split doesn't match how people
// think about content (games live under both Console and PC, anime under TV).

export interface CategoryChip {
  id: string
  label: string
  match: (cat: number) => boolean
  adult?: boolean
}

export const CATEGORY_CHIPS: CategoryChip[] = [
  { id: 'movies', label: 'Movies', match: (c) => parentCategory(c) === 2000 },
  { id: 'tv', label: 'TV', match: (c) => parentCategory(c) === 5000 && c !== 5070 },
  { id: 'anime', label: 'Anime', match: (c) => c === 5070 },
  { id: 'music', label: 'Music', match: (c) => parentCategory(c) === 3000 },
  { id: 'games', label: 'Games', match: (c) => parentCategory(c) === 1000 || c === 4050 },
  { id: 'software', label: 'Software', match: (c) => parentCategory(c) === 4000 && c !== 4050 },
  { id: 'books', label: 'Books', match: (c) => parentCategory(c) === 7000 },
  { id: 'other', label: 'Other', match: (c) => parentCategory(c) === 8000 },
  { id: 'xxx', label: 'XXX', match: (c) => parentCategory(c) === 6000, adult: true },
]

export const isAdult = (cats: number[]) => cats.length > 0 && cats.every((c) => parentCategory(c) === 6000)

/** Short label for a result's category, e.g. "Movies · HD" */
export function categoryLabel(cats: number[]): string | undefined {
  const specific = cats.find((c) => c % 1000 !== 0) ?? cats[0]
  if (specific == null) return undefined
  const name = categoryName(specific)
  return name?.replace('/', ' · ')
}
