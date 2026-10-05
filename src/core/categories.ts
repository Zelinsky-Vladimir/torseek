// Torznab standard categories. Every tracker's own categories are mapped onto these,
// which is what lets us filter "Movies" across 50 sites at once.

export const TORZNAB_CATEGORIES: Record<string, number> = {
  Console: 1000,
  'Console/NDS': 1010,
  'Console/PSP': 1020,
  'Console/Wii': 1030,
  'Console/XBox': 1040,
  'Console/XBox 360': 1050,
  'Console/Wiiware': 1060,
  'Console/XBox 360 DLC': 1070,
  'Console/PS3': 1080,
  'Console/Other': 1090,
  'Console/3DS': 1110,
  'Console/PS Vita': 1120,
  'Console/WiiU': 1130,
  'Console/XBox One': 1140,
  'Console/PS4': 1180,
  Movies: 2000,
  'Movies/Foreign': 2010,
  'Movies/Other': 2020,
  'Movies/SD': 2030,
  'Movies/HD': 2040,
  'Movies/UHD': 2045,
  'Movies/BluRay': 2050,
  'Movies/3D': 2060,
  'Movies/DVD': 2070,
  'Movies/WEB-DL': 2080,
  Audio: 3000,
  'Audio/MP3': 3010,
  'Audio/Video': 3020,
  'Audio/Audiobook': 3030,
  'Audio/Lossless': 3040,
  'Audio/Other': 3050,
  'Audio/Foreign': 3060,
  PC: 4000,
  'PC/0day': 4010,
  'PC/ISO': 4020,
  'PC/Mac': 4030,
  'PC/Mobile-Other': 4040,
  'PC/Games': 4050,
  'PC/Mobile-iOS': 4060,
  'PC/Mobile-Android': 4070,
  TV: 5000,
  'TV/WEB-DL': 5010,
  'TV/Foreign': 5020,
  'TV/SD': 5030,
  'TV/HD': 5040,
  'TV/UHD': 5045,
  'TV/Other': 5050,
  'TV/Sport': 5060,
  'TV/Anime': 5070,
  'TV/Documentary': 5080,
  XXX: 6000,
  'XXX/DVD': 6010,
  'XXX/WMV': 6020,
  'XXX/XviD': 6030,
  'XXX/x264': 6040,
  'XXX/UHD': 6045,
  'XXX/Pack': 6050,
  'XXX/ImageSet': 6060,
  'XXX/Other': 6070,
  'XXX/SD': 6080,
  'XXX/WEB-DL': 6090,
  Books: 7000,
  'Books/Mags': 7010,
  'Books/EBook': 7020,
  'Books/Comics': 7030,
  'Books/Technical': 7040,
  'Books/Other': 7050,
  'Books/Foreign': 7060,
  Other: 8000,
  'Other/Misc': 8010,
  'Other/Hashed': 8020,
}

const NAME_BY_ID = new Map(Object.entries(TORZNAB_CATEGORIES).map(([name, id]) => [id, name]))

export const categoryName = (id: number) => NAME_BY_ID.get(id)

/** 2040 -> 2000 */
export const parentCategory = (id: number) => Math.floor(id / 1000) * 1000

/** Does `id` fall under `wanted`? A top-level `wanted` (e.g. 2000) matches all its children. */
export const categoryMatches = (id: number, wanted: number) =>
  id === wanted || (wanted % 1000 === 0 && parentCategory(id) === wanted)

interface Mapping {
  trackerId: string
  torznab: number
  desc?: string
}

/** Per-tracker mapping between tracker category ids/descriptions and Torznab ids. */
export class CategoryMap {
  private mappings: Mapping[] = []
  readonly defaults: string[] = []

  add(trackerId: string, torznabName: string | undefined, desc?: string, isDefault = false) {
    const torznab = torznabName ? TORZNAB_CATEGORIES[torznabName] : undefined
    if (torznab === undefined) return false
    this.mappings.push({ trackerId, torznab, desc })
    if (isDefault) this.defaults.push(trackerId)
    return true
  }

  fromTrackerId(trackerId: string): number[] {
    if (!trackerId.trim()) return []
    const key = trackerId.toLowerCase()
    return this.mappings.filter((m) => m.trackerId.toLowerCase() === key).map((m) => m.torznab)
  }

  fromTrackerDesc(desc: string): number[] {
    if (!desc.trim()) return []
    const key = desc.toLowerCase()
    return this.mappings.filter((m) => m.desc?.toLowerCase() === key).map((m) => m.torznab)
  }

  /** Torznab ids from a query -> tracker category ids to send to the site. */
  toTrackerIds(torznabIds: number[]): string[] {
    const out = new Set<string>()
    for (const m of this.mappings) {
      if (torznabIds.some((wanted) => categoryMatches(m.torznab, wanted))) out.add(m.trackerId)
    }
    return [...out]
  }

  /** Top-level Torznab categories this tracker has anything in. */
  topLevel(): number[] {
    return [...new Set(this.mappings.map((m) => parentCategory(m.torznab)))].sort((a, b) => a - b)
  }
}
