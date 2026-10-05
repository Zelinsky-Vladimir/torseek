// Audio and subtitle tracks of a video file, read from its header: the only reliable
// answer to "does this release have English audio / subtitles". Needs a few MB of the
// file (Matroska keeps the track list near the start; MP4 keeps it in the moov box, at
// the start or at the very end), so it works on a torrent that has barely started.

export interface MediaTrack {
  kind: 'audio' | 'subtitle'
  /** Two-letter code when known ("en", "ru"), otherwise the file's code or "und" */
  lang: string
  name?: string
  codec?: string
  forced?: boolean
  default?: boolean
  /** A separate subtitle file in the torrent rather than a track inside the video */
  external?: boolean
}

export interface MediaTracks {
  /** Path of the video inside the torrent */
  file: string
  container: 'mkv' | 'mp4' | 'other'
  tracks: MediaTrack[]
}

/** Reads bytes [start, end] (inclusive) of the file */
export type ReadRange = (start: number, end: number) => Promise<Uint8Array>

const ISO639_2: Record<string, string> = {
  eng: 'en', rus: 'ru', ukr: 'uk', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', pol: 'pl',
  jpn: 'ja', chi: 'zh', zho: 'zh', kor: 'ko', tur: 'tr', cze: 'cs', ces: 'cs', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no',
  dan: 'da', fin: 'fi', hun: 'hu', gre: 'el', ell: 'el', heb: 'he', ara: 'ar', hin: 'hi', tha: 'th', vie: 'vi', ind: 'id',
  rum: 'ro', ron: 'ro', bul: 'bg', hrv: 'hr', srp: 'sr', slv: 'sl', slo: 'sk', slk: 'sk', est: 'et', lav: 'lv', lit: 'lt',
  bel: 'be', kaz: 'kk', geo: 'ka', kat: 'ka', arm: 'hy', hye: 'hy', per: 'fa', fas: 'fa', may: 'ms', msa: 'ms', cat: 'ca',
}

export function normalizeLang(code: string | undefined): string {
  const c = (code ?? '').trim().toLowerCase()
  if (!c || c === 'und' || c === 'mis' || c === 'zxx') return 'und'
  const base = c.split(/[-_]/)[0]
  return base.length === 2 ? base : (ISO639_2[base] ?? base)
}

export const VIDEO_FILE = /\.(mkv|mp4|m4v|mov|webm|avi|ts|m2ts|wmv)$/i
export const SUBTITLE_FILE = /\.(srt|ass|ssa|vtt|sub|idx|sup)$/i

// --- Matroska (EBML) ---------------------------------------------------------------

const EBML = 0x1a45dfa3
const SEGMENT = 0x18538067
const SEEK_HEAD = 0x114d9b74
const SEEK = 0x4dbb
const SEEK_ID = 0x53ab
const SEEK_POSITION = 0x53ac
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const CLUSTER = 0x1f43b675

interface El {
  id: number
  /** Offset of the data, and its size (-1 = unknown) */
  data: number
  size: number
}

function vint(b: Uint8Array, p: number, keepMarker: boolean): { value: number; len: number } | null {
  if (p >= b.length) return null
  const first = b[p]
  let len = 1
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
  if (len > 8 || p + len > b.length) return null
  let value = keepMarker ? first : first & (0xff >> len)
  let allOnes = value === 0xff >> len
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[p + i]
    if (b[p + i] !== 0xff) allOnes = false
  }
  return { value: !keepMarker && allOnes ? -1 : value, len }
}

function element(b: Uint8Array, p: number): El | null {
  const id = vint(b, p, true)
  if (!id) return null
  const size = vint(b, p + id.len, false)
  if (!size) return null
  return { id: id.value, data: p + id.len + size.len, size: size.value }
}

function* children(b: Uint8Array, start: number, end: number): Generator<El> {
  let p = start
  while (p < end) {
    const el = element(b, p)
    if (!el || el.size < 0) return
    yield el
    p = el.data + el.size
  }
}

const uint = (b: Uint8Array, el: El) => {
  let v = 0
  for (let i = 0; i < el.size; i++) v = v * 256 + b[el.data + i]
  return v
}
const str = (b: Uint8Array, el: El) => new TextDecoder().decode(b.subarray(el.data, el.data + el.size)).replace(/\0+$/, '')

function mkvTrackList(b: Uint8Array, el: El): MediaTrack[] {
  const tracks: MediaTrack[] = []
  for (const entry of children(b, el.data, el.data + el.size)) {
    if (entry.id !== TRACK_ENTRY) continue
    // Language defaults to English in Matroska when the element is absent
    let type = 0
    let lang = 'eng'
    let bcp47: string | undefined
    let name: string | undefined
    let codec: string | undefined
    let forced = false
    let isDefault = true
    for (const f of children(b, entry.data, entry.data + entry.size)) {
      if (f.id === 0x83) type = uint(b, f)
      else if (f.id === 0x22b59c) lang = str(b, f)
      else if (f.id === 0x22b59d) bcp47 = str(b, f)
      else if (f.id === 0x536e) name = str(b, f)
      else if (f.id === 0x86) codec = str(b, f)
      else if (f.id === 0x55aa) forced = uint(b, f) === 1
      else if (f.id === 0x88) isDefault = uint(b, f) === 1
    }
    if (type !== 2 && type !== 17) continue
    tracks.push({ kind: type === 2 ? 'audio' : 'subtitle', lang: normalizeLang(bcp47 ?? lang), name, codec, forced, default: isDefault })
  }
  return tracks
}

async function readMkv(read: ReadRange, size: number): Promise<MediaTrack[] | null> {
  const head = await read(0, Math.min(size, 2 * 1024 * 1024) - 1)
  const ebml = element(head, 0)
  if (!ebml || ebml.id !== EBML) return null
  const seg = element(head, ebml.data + ebml.size)
  if (!seg || seg.id !== SEGMENT) return null
  const segEnd = seg.size < 0 ? Infinity : seg.data + seg.size

  // Element whose header is at an absolute offset, read in full
  const readElement = async (offset: number, id: number): Promise<{ buf: Uint8Array; el: El } | null> => {
    let buf = offset + 16 <= head.length ? head.subarray(offset) : await read(offset, Math.min(size - 1, offset + 15))
    const el = element(buf, 0)
    if (!el || el.id !== id || el.size < 0 || el.size > 16 * 1024 * 1024) return null
    if (el.data + el.size > buf.length) buf = await read(offset, Math.min(size - 1, offset + el.data + el.size - 1))
    return { buf, el }
  }

  let tracksAt: number | undefined
  let p = seg.data
  while (p < Math.min(head.length, segEnd)) {
    const el = element(head, p)
    if (!el) break
    if (el.id === TRACKS) {
      tracksAt = p
      break
    }
    if (el.id === SEEK_HEAD && el.size > 0 && el.data + el.size <= head.length) {
      for (const seek of children(head, el.data, el.data + el.size)) {
        if (seek.id !== SEEK) continue
        let sid = 0
        let pos = -1
        for (const f of children(head, seek.data, seek.data + seek.size)) {
          if (f.id === SEEK_ID) sid = uint(head, f)
          else if (f.id === SEEK_POSITION) pos = uint(head, f)
        }
        if (sid === TRACKS && pos >= 0) tracksAt ??= seg.data + pos
      }
    }
    if (el.id === CLUSTER || el.size < 0) break
    p = el.data + el.size
  }
  if (tracksAt === undefined) return null
  const found = await readElement(tracksAt, TRACKS)
  return found ? mkvTrackList(found.buf, found.el) : null
}

// --- MP4 / MOV (ISO BMFF) ------------------------------------------------------------

interface Box {
  type: string
  data: number
  end: number
}

function box(b: Uint8Array, p: number, limit = b.length): Box | null {
  if (p + 8 > limit) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let size = dv.getUint32(p)
  const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7])
  let header = 8
  if (size === 1) {
    if (p + 16 > limit) return null
    size = Number(dv.getBigUint64(p + 8))
    header = 16
  } else if (size === 0) size = limit - p
  if (size < header) return null
  return { type, data: p + header, end: p + size }
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let p = start
  while (p < end) {
    const bx = box(b, p, end)
    if (!bx) return
    yield bx
    p = bx.end
  }
}

const findBox = (b: Uint8Array, parent: Box, type: string) => [...boxes(b, parent.data, parent.end)].find((x) => x.type === type)

function mp4Language(b: Uint8Array, mdhd: Box): string {
  const version = b[mdhd.data]
  const at = mdhd.data + (version === 1 ? 4 + 8 + 8 + 4 + 8 : 4 + 4 + 4 + 4 + 4)
  const packed = (b[at] << 8) | b[at + 1]
  if (!packed || packed === 0x7fff) return 'und'
  const code = String.fromCharCode(((packed >> 10) & 31) + 0x60, ((packed >> 5) & 31) + 0x60, (packed & 31) + 0x60)
  return code
}

function mp4TrackList(b: Uint8Array, moov: Box): MediaTrack[] {
  const tracks: MediaTrack[] = []
  for (const trak of boxes(b, moov.data, moov.end)) {
    if (trak.type !== 'trak') continue
    const mdia = findBox(b, trak, 'mdia')
    if (!mdia) continue
    const hdlr = findBox(b, mdia, 'hdlr')
    const mdhd = findBox(b, mdia, 'mdhd')
    const elng = findBox(b, mdia, 'elng')
    if (!hdlr) continue
    const handler = String.fromCharCode(...b.subarray(hdlr.data + 8, hdlr.data + 12))
    const kind = handler === 'soun' ? 'audio' : ['sbtl', 'subt', 'text', 'clcp'].includes(handler) ? 'subtitle' : null
    if (!kind) continue
    const name = new TextDecoder().decode(b.subarray(hdlr.data + 24, hdlr.end)).replace(/\0[\s\S]*$/, '').trim() || undefined
    const extended = elng ? new TextDecoder().decode(b.subarray(elng.data + 4, elng.end)).replace(/\0[\s\S]*$/, '') : undefined
    const lang = normalizeLang(extended || (mdhd ? mp4Language(b, mdhd) : 'und'))
    // Handler names like "SoundHandler" / "Core Media Audio" say nothing
    const useful = name && !/handler|core media|^(sound|video|subtitle|text)$/i.test(name) ? name : undefined
    tracks.push({ kind, lang, name: useful })
  }
  return tracks
}

async function readMp4(read: ReadRange, size: number): Promise<MediaTrack[] | null> {
  // Walk the top-level boxes; moov is either before mdat (fast start) or after it
  let p = 0
  for (let i = 0; i < 64 && p + 8 <= size; i++) {
    const hdr = await read(p, Math.min(size - 1, p + 15))
    const bx = box(hdr, 0, Infinity)
    if (!bx) return null
    if (i === 0 && bx.type !== 'ftyp' && bx.type !== 'moov' && bx.type !== 'free' && bx.type !== 'wide') return null
    const total = bx.end
    if (bx.type === 'moov') {
      if (total > 64 * 1024 * 1024) return null
      const buf = await read(p, Math.min(size - 1, p + total - 1))
      return mp4TrackList(buf, { type: 'moov', data: bx.data, end: total })
    }
    p += total
  }
  return null
}

// --- Entry points ------------------------------------------------------------------

export async function readMediaTracks(path: string, size: number, read: ReadRange): Promise<MediaTracks> {
  const lower = path.toLowerCase()
  let container: MediaTracks['container'] = 'other'
  let tracks: MediaTrack[] | null = null
  try {
    if (/\.(mkv|webm)$/.test(lower)) {
      container = 'mkv'
      tracks = await readMkv(read, size)
    } else if (/\.(mp4|m4v|mov)$/.test(lower)) {
      container = 'mp4'
      tracks = await readMp4(read, size)
    }
  } catch {
    tracks = null
  }
  return { file: path, container, tracks: tracks ?? [] }
}

const LANG_NAMES: Record<string, string> = {
  english: 'en', russian: 'ru', ukrainian: 'uk', french: 'fr', german: 'de', spanish: 'es', italian: 'it', portuguese: 'pt',
  polish: 'pl', dutch: 'nl', japanese: 'ja', chinese: 'zh', korean: 'ko', turkish: 'tr', czech: 'cs', swedish: 'sv',
  norwegian: 'no', danish: 'da', finnish: 'fi', hungarian: 'hu', greek: 'el', hebrew: 'he', arabic: 'ar', romanian: 'ro',
  bulgarian: 'bg', croatian: 'hr', serbian: 'sr', vietnamese: 'vi', thai: 'th', indonesian: 'id', hindi: 'hi',
  английские: 'en', английский: 'en', русские: 'ru', русский: 'ru', украинские: 'uk', украинский: 'uk',
  eng: 'en', rus: 'ru', ukr: 'uk', chs: 'zh', cht: 'zh', ua: 'uk', br: 'pt',
}
const TWO_LETTER = new Set(Object.values(ISO639_2))

/** Language of a subtitle file from its name: "Sintel.nl.srt", "Subs/2_English.srt", "rus.forced.ass" */
function subtitleFileLang(path: string): string {
  const words = path
    .replace(SUBTITLE_FILE, '')
    .split(/[\s._\-[\]()/\\,]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean)
  const known = (w: string, allowShort: boolean) => LANG_NAMES[w] ?? (w.length === 3 ? ISO639_2[w] : allowShort && TWO_LETTER.has(w) ? w : undefined)
  // The last words carry the language ("Movie.2019.en.forced"); two-letter codes only count there
  for (const [i, w] of [...words.entries()].reverse()) {
    if (w === 'forced' || w === 'sdh' || w === 'full' || w === 'cc') continue
    const lang = known(w, i >= words.length - 2)
    if (lang) return lang
  }
  if (/англ/i.test(path)) return 'en'
  if (/рус/i.test(path)) return 'ru'
  if (/укр/i.test(path)) return 'uk'
  return 'und'
}

/** Subtitle files shipped next to the video ("Subs/2_English.srt") */
export function externalSubtitles(paths: string[]): MediaTrack[] {
  return paths
    .filter((p) => SUBTITLE_FILE.test(p))
    .map((p) => ({ kind: 'subtitle' as const, lang: subtitleFileLang(p), name: p.split(/[\\/]/).pop(), external: true, forced: /forced/i.test(p) }))
}

/** The file whose tracks describe the release: the biggest video */
export function mainVideo<T extends { path: string; length: number }>(files: T[]): T | undefined {
  return files.filter((f) => VIDEO_FILE.test(f.path) && !/\bsample\b/i.test(f.path)).sort((a, b) => b.length - a.length)[0]
}
