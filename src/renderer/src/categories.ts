import { categoryName } from '../../core/categories'
import { CHIP_MATCHERS, isAdult, type ChipId } from '../../core/filters'
import { t, type Key } from './i18n'

// UI-level category groups (matchers live in core/filters so watch checks agree with the UI).

export interface CategoryChip {
  id: ChipId
  label: Key
  match: (cat: number) => boolean
  adult?: boolean
}

const chip = (id: ChipId, adult = false): CategoryChip => ({ id, label: `cat.${id}` as Key, match: CHIP_MATCHERS[id], adult })

export const CATEGORY_CHIPS: CategoryChip[] = [
  chip('movies'), chip('tv'), chip('anime'), chip('music'), chip('games'), chip('software'), chip('books'), chip('other'), chip('xxx', true),
]

export { isAdult }

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
