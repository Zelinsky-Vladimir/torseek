import { describe, expect, it } from 'vitest'
import { externalSubtitles, mainVideo, readMediaTracks, type ReadRange } from '../src/core/media-tracks'

// --- tiny EBML writer -------------------------------------------------------------

const idBytes = (id: number) => {
  const out: number[] = []
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff)
  return out
}
const el = (id: number, body: number[] | Uint8Array): number[] => {
  const data = [...body]
  // 4-byte size VINT (marker 0x10)
  const n = data.length
  return [...idBytes(id), 0x10 | ((n >>> 24) & 0x0f), (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...data]
}
const u = (id: number, v: number) => el(id, [v])
const s = (id: number, text: string) => el(id, [...new TextEncoder().encode(text)])
const track = (type: number, lang?: string, extra: number[] = []) => el(0xae, [...u(0x83, type), ...(lang ? s(0x22b59c, lang) : []), ...extra])

function mkv(tracks: number[][], { clusterFirst = false } = {}) {
  const header = el(0x1a45dfa3, s(0x4282, 'matroska'))
  const tracksEl = el(0x1654ae6b, tracks.flat())
  const info = el(0x1549a966, u(0x2ad7b1, 1))
  const cluster = el(0x1f43b675, new Array(64).fill(0))
  let body: number[]
  if (clusterFirst) {
    // Tracks after the first cluster, found through the SeekHead
    const seekHeadLen = el(0x114d9b74, el(0x4dbb, [...el(0x53ab, idBytes(0x1654ae6b)), ...el(0x53ac, [0, 0, 0, 0])])).length
    const pos = seekHeadLen + info.length + cluster.length
    const seekHead = el(0x114d9b74, el(0x4dbb, [...el(0x53ab, idBytes(0x1654ae6b)), ...el(0x53ac, [(pos >>> 24) & 0xff, (pos >>> 16) & 0xff, (pos >>> 8) & 0xff, pos & 0xff])]))
    body = [...seekHead, ...info, ...cluster, ...tracksEl]
  } else body = [...info, ...tracksEl, ...cluster]
  return new Uint8Array([...header, ...el(0x18538067, body)])
}

// --- tiny MP4 writer --------------------------------------------------------------

const box = (type: string, body: number[]): number[] => {
  const n = body.length + 8
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...[...type].map((c) => c.charCodeAt(0)), ...body]
}
const packLang = (code: string) => {
  const v = ((code.charCodeAt(0) - 0x60) << 10) | ((code.charCodeAt(1) - 0x60) << 5) | (code.charCodeAt(2) - 0x60)
  return [(v >> 8) & 0xff, v & 0xff]
}
const mp4Track = (handler: string, lang: string) =>
  box('trak', box('mdia', [...box('mdhd', [0, 0, 0, 0, ...new Array(16).fill(0), ...packLang(lang), 0, 0]), ...box('hdlr', [0, 0, 0, 0, 0, 0, 0, 0, ...[...handler].map((c) => c.charCodeAt(0)), ...new Array(12).fill(0), 0])]))

function mp4(tracks: number[][], moovAtEnd = false) {
  const ftyp = box('ftyp', [...'isom'].map((c) => c.charCodeAt(0)).concat([0, 0, 2, 0]))
  const moov = box('moov', tracks.flat())
  const mdat = box('mdat', new Array(1000).fill(7))
  return new Uint8Array(moovAtEnd ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat])
}

const reader = (buf: Uint8Array): ReadRange => async (start, end) => buf.subarray(start, end + 1)

describe('media tracks', () => {
  it('reads Matroska audio and subtitle languages', async () => {
    const file = mkv([track(1, 'und'), track(2, 'rus', s(0x536e, 'Дубляж')), track(2), track(17, 'eng', u(0x55aa, 1)), track(17, 'rus')])
    const r = await readMediaTracks('Movie.mkv', file.length, reader(file))
    expect(r.container).toBe('mkv')
    expect(r.tracks).toEqual([
      expect.objectContaining({ kind: 'audio', lang: 'ru', name: 'Дубляж' }),
      // no Language element means English in Matroska
      expect.objectContaining({ kind: 'audio', lang: 'en' }),
      expect.objectContaining({ kind: 'subtitle', lang: 'en', forced: true }),
      expect.objectContaining({ kind: 'subtitle', lang: 'ru' }),
    ])
  })

  it('follows the SeekHead when Tracks come after a cluster', async () => {
    const file = mkv([track(2, 'jpn'), track(17, 'eng')], { clusterFirst: true })
    const r = await readMediaTracks('anime.mkv', file.length, reader(file))
    expect(r.tracks.map((t) => `${t.kind}:${t.lang}`)).toEqual(['audio:ja', 'subtitle:en'])
  })

  it('reads MP4 tracks with moov at the start or the end', async () => {
    for (const atEnd of [false, true]) {
      const file = mp4([mp4Track('vide', 'und'), mp4Track('soun', 'eng'), mp4Track('soun', 'fre'), mp4Track('sbtl', 'eng')], atEnd)
      const r = await readMediaTracks('movie.mp4', file.length, reader(file))
      expect(r.tracks.map((t) => `${t.kind}:${t.lang}`)).toEqual(['audio:en', 'audio:fr', 'subtitle:en'])
    }
  })

  it('returns no tracks for garbage', async () => {
    const junk = new Uint8Array(4096).fill(3)
    expect((await readMediaTracks('x.mkv', junk.length, reader(junk))).tracks).toEqual([])
    expect((await readMediaTracks('x.mp4', junk.length, reader(junk))).tracks).toEqual([])
  })

  it('finds subtitle files and the main video', () => {
    expect(externalSubtitles(['Movie/Subs/2_English.srt', 'Movie/Subs/Russian.Forced.srt', 'Movie/movie.mkv']).map((t) => `${t.lang}${t.forced ? '!' : ''}`)).toEqual(['en', 'ru!'])
    const langs = (paths: string[]) => externalSubtitles(paths).map((t) => t.lang)
    expect(langs(['Sintel/Sintel.nl.srt', 'Sintel/Sintel.pl.srt', 'Movie.2019.en.forced.srt', 'Subs/rus.ass', 'Subs/Английские.srt'])).toEqual(['nl', 'pl', 'en', 'ru', 'en'])
    // "It" is a title word here, not Italian
    expect(langs(['It.Follows.2014.1080p.srt'])).toEqual(['und'])
    expect(mainVideo([{ path: 'a/sample.mkv', length: 9e9 }, { path: 'a/movie.mkv', length: 5e9 }, { path: 'a/extra.mp4', length: 1e9 }])?.path).toBe('a/movie.mkv')
  })
})
