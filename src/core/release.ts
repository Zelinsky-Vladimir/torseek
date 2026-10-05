import { audioOf, type AudioInfo } from './audio'
// A single search result from a single tracker, normalised.
export interface Release {
  indexerId: string
  indexerName: string
  title: string
  /** Stable id within a tracker (download link, magnet or details URL) */
  guid: string
  details?: string
  /** .torrent URL, or a details page the definition knows how to resolve */
  link?: string
  magnet?: string
  infoHash?: string
  size?: number
  seeders?: number
  leechers?: number
  grabs?: number
  files?: number
  /** ISO 8601 */
  publishDate?: string
  categories: number[]
  imdb?: number
  poster?: string
  description?: string
  genres?: string[]
  /** 0 = freeleech */
  downloadVolumeFactor?: number
  uploadVolumeFactor?: number
}

// Same public trackers Jackett adds when building a magnet from a bare info hash
const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.srv00.com:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
]

export function infoHashToMagnet(infoHash: string, title: string): string {
  const tr = PUBLIC_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}${tr}`
}

export function magnetToInfoHash(magnet: string): string | undefined {
  const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet)
  return m ? normalizeInfoHash(m[1]) : undefined
}

/** Lower-case hex; some sites publish the 32-char base32 form instead. */
export function normalizeInfoHash(hash: string): string {
  if (/^[a-z2-7]{32}$/i.test(hash)) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = ''
    for (const c of hash.toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0')
    return bits.match(/.{4}/g)!.map((b) => Number.parseInt(b, 2).toString(16)).join('')
  }
  return hash.toLowerCase()
}

// --- Quality tags parsed from the title, for badges and filters ---

export interface Quality {
  resolution?: '2160p' | '1080p' | '720p' | '480p'
  source?: 'BluRay' | 'Remux' | 'WEB-DL' | 'WEBRip' | 'HDTV' | 'DVD' | 'CAM'
  codec?: 'x265' | 'x264' | 'AV1' | 'XviD'
  hdr?: 'HDR' | 'DV'
}

export function parseQuality(title: string): Quality {
  const t = title.toLowerCase()
  const q: Quality = {}
  if (/\b(2160p|4k|uhd)\b/.test(t)) q.resolution = '2160p'
  else if (/\b1080[pi]\b/.test(t)) q.resolution = '1080p'
  else if (/\b720p\b/.test(t)) q.resolution = '720p'
  else if (/\b(480p|576p|sd)\b/.test(t)) q.resolution = '480p'

  if (/\bremux\b/.test(t)) q.source = 'Remux'
  else if (/\b(blu-?ray|bdrip|brrip|bdremux)\b/.test(t)) q.source = 'BluRay'
  else if (/\bweb-?dl\b/.test(t)) q.source = 'WEB-DL'
  else if (/\bweb-?rip\b|\bweb\b/.test(t)) q.source = 'WEBRip'
  else if (/\bhdtv(rip)?\b/.test(t)) q.source = 'HDTV'
  else if (/\bdvd(rip|5|9)?\b/.test(t)) q.source = 'DVD'
  else if (/\b(cam|camrip|hdcam|ts|telesync|hdts)\b/.test(t)) q.source = 'CAM'

  if (/\b(x\.?265|h\.?265|hevc)\b/.test(t)) q.codec = 'x265'
  else if (/\b(x\.?264|h\.?264|avc)\b/.test(t)) q.codec = 'x264'
  else if (/\bav1\b/.test(t)) q.codec = 'AV1'
  else if (/\bxvid\b/.test(t)) q.codec = 'XviD'

  if (/\b(dv|dovi|dolby\.?vision)\b/.test(t)) q.hdr = 'DV'
  else if (/\bhdr(10\+?)?\b/.test(t)) q.hdr = 'HDR'
  return q
}

// --- Grouping the same torrent across trackers ---

export interface ReleaseGroup {
  key: string
  /** Best-seeded copy, used for display and download */
  primary: Release
  sources: Release[]
  quality: Quality
  audio: AudioInfo
}

export function groupKey(r: Release): string {
  if (r.infoHash) return 'h:' + r.infoHash.toLowerCase()
  // Without a hash, only merge exact title+size matches to avoid false positives
  return `t:${r.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}:${r.size ?? ''}`
}

export function groupReleases(releases: Release[], existing = new Map<string, ReleaseGroup>()): Map<string, ReleaseGroup> {
  for (const r of releases) {
    const key = groupKey(r)
    const g = existing.get(key)
    if (!g) {
      existing.set(key, { key, primary: r, sources: [r], quality: parseQuality(r.title), audio: audioOf(r.title, r.categories.includes(5070)) })
      continue
    }
    if (g.sources.some((s) => s.indexerId === r.indexerId && s.guid === r.guid)) continue
    g.sources.push(r)
    if ((r.seeders ?? 0) > (g.primary.seeders ?? 0)) g.primary = r
  }
  return existing
}
