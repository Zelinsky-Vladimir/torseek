import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import WebTorrent from 'webtorrent'
import type { Torrent, TorrentFile } from 'webtorrent'
import parseTorrent from 'parse-torrent'
import type { DownloadTarget } from '../core/indexer'
import { magnetToInfoHash } from '../core/release'
import { externalSubtitles, mainVideo, readMediaTracks, type MediaTracks } from '../core/media-tracks'
import type { TorrentFileInfo, TorrentInfo } from '../shared/api'
import type { JsonStore } from './store'

// Built-in BitTorrent client on top of WebTorrent (pure JS: TCP, uTP, DHT, PEX, trackers).
// Every torrent is persisted as a record plus its .torrent metadata so downloads resume
// after a restart; WebTorrent re-verifies pieces already on disk.
//
// Partial downloads: the record keeps the indexes of deselected files. WebTorrent never
// marks a partially selected torrent as done, so completion is tracked here over the
// selected files only.

export interface TorrentRecord {
  infoHash: string
  name: string
  magnet?: string
  path: string
  addedAt: number
  paused: boolean
  /** All selected files are complete */
  done: boolean
  completedAt?: number
  /** File indexes the user chose not to download */
  deselected?: number[]
  source?: { indexerName: string; details?: string }
  /** Audio / subtitle tracks of the main video, read from its header */
  tracks?: MediaTracks
}

export interface TorrentStoreShape {
  torrents: TorrentRecord[]
}

export interface TorrentManagerOptions {
  seedAfterDownload: () => boolean
  /** Called once when every selected file of a torrent has finished */
  onComplete?: (rec: TorrentRecord) => void
}

// Added to every torrent, as most clients do: magnets from index sites often list only
// trackers that died years ago, and then the metadata never arrives
// DHT entry points. The library's default three barely answer from many networks
// (1 node, 0 peers in a minute where this list gets ~25 nodes and dozens of peers)
const DHT_BOOTSTRAP = [
  'router.bittorrent.com:6881',
  'router.utorrent.com:6881',
  'dht.transmissionbt.com:6881',
  'dht.libtorrent.org:25401',
  'dht.aelitis.com:6881',
]

const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://opentracker.io:6969/announce',
  'http://tracker.opentrackr.org:1337/announce',
]

export class TorrentManager {
  private client: WebTorrent.Instance
  private live = new Map<string, Torrent>()
  private errors = new Map<string, string>()

  constructor(
    private readonly store: JsonStore<TorrentStoreShape>,
    private readonly metaDir: string,
    private readonly opts: TorrentManagerOptions,
    private readonly log: (msg: string) => void = () => {},
  ) {
    // Nodes from the last run make the DHT useful right away instead of after minutes
    let nodes: unknown[] | undefined
    try {
      nodes = JSON.parse(readFileSync(this.dhtFile(), 'utf8'))
    } catch {
      /* first run */
    }
    this.client = new WebTorrent({ dht: { bootstrap: DHT_BOOTSTRAP, ...(nodes?.length ? { nodes } : {}) } })
    this.client.on('error', (err) => this.log(`webtorrent: ${String(err)}`))
    setInterval(() => void this.saveDhtNodes(), 10 * 60_000).unref()
  }

  private dhtFile() {
    return join(this.metaDir, 'dht-nodes.json')
  }

  private async saveDhtNodes() {
    const nodes = (this.client.dht as { toJSON?: () => { nodes: unknown[] } } | undefined)?.toJSON?.().nodes
    if (nodes?.length) await writeFile(this.dhtFile(), JSON.stringify(nodes.slice(0, 500))).catch(() => {})
  }

  async init() {
    await mkdir(this.metaDir, { recursive: true })
    // Leftovers of track probes interrupted by a quit
    await rm(join(this.metaDir, 'probe'), { recursive: true, force: true }).catch(() => {})
    for (const rec of this.records()) if (!rec.paused) void this.start(rec)
  }

  private records(): TorrentRecord[] {
    return this.store.get().torrents
  }

  private record(infoHash: string): TorrentRecord {
    const rec = this.records().find((r) => r.infoHash === infoHash)
    if (!rec) throw new Error(`Unknown torrent ${infoHash}`)
    return rec
  }

  private patch(infoHash: string, patch: Partial<TorrentRecord>) {
    this.store.update(() => Object.assign(this.record(infoHash), patch))
  }

  private metaFile(infoHash: string) {
    return join(this.metaDir, `${infoHash}.torrent`)
  }

  /** title names the torrent until its metadata arrives (magnets often have an empty dn) */
  async add(target: DownloadTarget, path: string, source?: TorrentRecord['source'], title?: string): Promise<{ infoHash: string }> {
    let infoHash: string
    let name: string
    let magnet: string | undefined
    if (target.kind === 'torrent') {
      const parsed = await parseTorrent(Buffer.from(target.data))
      infoHash = parsed.infoHash!
      name = parsed.name?.toString() ?? infoHash
      await writeFile(this.metaFile(infoHash), target.data)
    } else {
      magnet = target.uri
      infoHash = magnetToInfoHash(target.uri) ?? ''
      if (!/^[0-9a-f]{40}$/.test(infoHash)) throw new Error('Unsupported magnet link')
      name = new URLSearchParams(target.uri.split('?')[1]).get('dn') || title || infoHash
    }

    const existing = this.records().find((r) => r.infoHash === infoHash)
    if (existing) {
      if (existing.paused) await this.resume(infoHash)
      return { infoHash }
    }
    const rec: TorrentRecord = { infoHash, name, magnet, path, addedAt: Date.now(), paused: false, done: false, source }
    this.store.update((d) => d.torrents.unshift(rec))
    await this.start(rec)
    return { infoHash }
  }

  async addMagnet(uri: string, path: string) {
    return this.add({ kind: 'magnet', uri }, path)
  }

  private async start(rec: TorrentRecord) {
    if (this.live.has(rec.infoHash)) return
    this.errors.delete(rec.infoHash)
    let torrentId: string | Buffer = rec.magnet ?? rec.infoHash
    try {
      torrentId = await readFile(this.metaFile(rec.infoHash))
    } catch {
      /* no metadata yet, fall back to the magnet */
    }

    const partial = (rec.deselected?.length ?? 0) > 0
    const torrent = this.client.add(torrentId, { path: rec.path, deselect: partial, announce: PUBLIC_TRACKERS })
    this.live.set(rec.infoHash, torrent)

    torrent.on('metadata', async () => {
      if (torrent.name && torrent.name !== rec.name) this.patch(rec.infoHash, { name: torrent.name })
      if (torrent.torrentFile) await writeFile(this.metaFile(rec.infoHash), torrent.torrentFile).catch(() => {})
    })
    torrent.on('ready', () => {
      if (partial) this.applySelection(torrent, this.record(rec.infoHash).deselected ?? [])
      torrent.files.forEach((f) => f.on('done', () => this.checkComplete(rec.infoHash)))
      this.checkComplete(rec.infoHash)
      if (!this.record(rec.infoHash).tracks) void this.detectTracks(torrent).then((tracks) => tracks && this.patch(rec.infoHash, { tracks }))
    })
    torrent.on('error', (err) => {
      this.errors.set(rec.infoHash, String((err as Error)?.message ?? err))
      this.live.delete(rec.infoHash)
    })
  }

  // Deselect everything, then select wanted files: pieces shared by a wanted and an
  // unwanted file at a boundary stay selected.
  private applySelection(torrent: Torrent, deselected: number[]) {
    if (!torrent.pieces?.length) return
    torrent.deselect(0, torrent.pieces.length - 1)
    torrent.files.forEach((f, i) => {
      if (!deselected.includes(i)) f.select()
    })
  }

  private selectedFiles(torrent: Torrent, rec: TorrentRecord): TorrentFile[] {
    return torrent.files.filter((_, i) => !rec.deselected?.includes(i))
  }

  private checkComplete(infoHash: string) {
    const t = this.live.get(infoHash)
    const rec = this.records().find((r) => r.infoHash === infoHash)
    if (!t || !rec || !t.ready) return
    const selected = this.selectedFiles(t, rec)
    const complete = selected.length > 0 && selected.every((f) => f.done)
    if (complete && !rec.done) {
      this.patch(infoHash, { done: true, completedAt: Date.now() })
      this.opts.onComplete?.(rec)
      if (!this.opts.seedAfterDownload()) void this.pause(infoHash)
    } else if (!complete && rec.done) {
      // More files were selected after completion
      this.patch(infoHash, { done: false })
    }
  }

  // --- Tracks: what audio / subtitles the release really has ---

  private probes = new Map<string, Promise<MediaTracks>>()

  /** Tracks of a ready torrent's main video, plus subtitle files next to it */
  private async detectTracks(torrent: Torrent): Promise<MediaTracks | undefined> {
    const main = mainVideo(torrent.files)
    const external = externalSubtitles(torrent.files.map((f) => f.path))
    if (!main) return external.length ? { file: '', container: 'other', tracks: external } : undefined
    const read = async (start: number, end: number) => {
      const chunks: Uint8Array[] = []
      for await (const c of main.createReadStream({ start, end })) chunks.push(c)
      return Buffer.concat(chunks)
    }
    try {
      const found = await readMediaTracks(main.path, main.length, read)
      return { ...found, tracks: [...found.tracks, ...external] }
    } catch (e) {
      this.log(`tracks ${torrent.infoHash}: ${(e as Error).message}`)
      return undefined
    }
  }

  /**
   * Tracks of a release without downloading it: join the swarm for the metadata and the
   * first piece(s) of the video, read the header, leave. Torrents already in the list are
   * read in place.
   */
  async infoHashOf(target: DownloadTarget): Promise<string> {
    const hash = target.kind === 'torrent' ? (await parseTorrent(Buffer.from(target.data))).infoHash : magnetToInfoHash(target.uri)
    if (!hash || !/^[0-9a-f]{40}$/.test(hash)) throw new Error('Unsupported magnet link')
    return hash
  }

  probe(target: DownloadTarget, infoHash: string): Promise<MediaTracks> {
    const cached = this.probes.get(infoHash)
    if (cached) return cached
    const rec = this.records().find((r) => r.infoHash === infoHash)
    if (rec?.tracks) return Promise.resolve(rec.tracks)
    const live = this.live.get(infoHash)
    const run = async (): Promise<MediaTracks> => {
      if (live) {
        if (!live.ready) await new Promise((resolve) => live.once('ready', resolve))
        const t = await this.detectTracks(live)
        if (!t) throw new Error('No video in this torrent')
        return t
      }
      const dir = join(this.metaDir, 'probe', infoHash)
      const id = target.kind === 'torrent' ? target.data : target.uri
      const torrent = this.client.add(id, { path: dir, deselect: true, announce: PUBLIC_TRACKERS })
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No peers sent the torrent in time')), 90_000)
          torrent.once('ready', () => (clearTimeout(timer), resolve()))
          torrent.once('error', (e) => (clearTimeout(timer), reject(e)))
        })
        const t = await Promise.race([
          this.detectTracks(torrent),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('No peers sent the video header in time')), 120_000)),
        ])
        if (!t) throw new Error('No video in this torrent')
        return t
      } finally {
        await new Promise<void>((resolve) => torrent.destroy({ destroyStore: true }, () => resolve()))
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
    const p = run()
    this.probes.set(infoHash, p)
    p.catch(() => this.probes.delete(infoHash))
    return p
  }

  /** Choose which files to download (indexes into the torrent's file list). */
  async setFileSelection(infoHash: string, selected: number[]) {
    const t = this.live.get(infoHash)
    const count = t?.files.length ?? 0
    const deselected = Array.from({ length: count }, (_, i) => i).filter((i) => !selected.includes(i))
    this.patch(infoHash, { deselected })
    if (t?.ready) {
      this.applySelection(t, deselected)
      this.checkComplete(infoHash)
    }
  }

  async pause(infoHash: string) {
    this.patch(infoHash, { paused: true })
    const t = this.live.get(infoHash)
    this.live.delete(infoHash)
    if (t) await new Promise<void>((resolve) => t.destroy({ destroyStore: false }, () => resolve()))
  }

  async resume(infoHash: string) {
    this.patch(infoHash, { paused: false })
    await this.start(this.record(infoHash))
  }

  async remove(infoHash: string, deleteFiles: boolean) {
    const rec = this.record(infoHash)
    const t = this.live.get(infoHash)
    this.live.delete(infoHash)
    if (t) await new Promise<void>((resolve) => t.destroy({ destroyStore: deleteFiles }, () => resolve()))
    else if (deleteFiles) await rm(join(rec.path, rec.name), { recursive: true, force: true })
    await rm(this.metaFile(infoHash), { force: true })
    this.store.update((d) => {
      d.torrents = d.torrents.filter((r) => r.infoHash !== infoHash)
    })
  }

  contentPath(infoHash: string): string {
    const rec = this.record(infoHash)
    const t = this.live.get(infoHash)
    return join(rec.path, t?.name ?? rec.name)
  }

  filePath(infoHash: string, index: number): string {
    const t = this.live.get(infoHash)
    const file = t?.files[index]
    if (!file) throw new Error('File not available (torrent paused or metadata missing)')
    return join(this.record(infoHash).path, file.path)
  }

  files(infoHash: string): TorrentFileInfo[] {
    const t = this.live.get(infoHash)
    const rec = this.records().find((r) => r.infoHash === infoHash)
    if (!t?.ready || !rec) return []
    return t.files.map((f, index) => ({
      index,
      name: f.name,
      path: f.path,
      length: f.length,
      downloaded: f.downloaded,
      progress: f.progress,
      selected: !rec.deselected?.includes(index),
    }))
  }

  setLimits(downloadKBs: number, uploadKBs: number) {
    this.client.throttleDownload(downloadKBs > 0 ? downloadKBs * 1024 : -1)
    this.client.throttleUpload(uploadKBs > 0 ? uploadKBs * 1024 : -1)
  }

  snapshot(): TorrentInfo[] {
    return this.records().map((rec) => {
      const t = this.live.get(rec.infoHash)
      const error = this.errors.get(rec.infoHash)
      const base = {
        infoHash: rec.infoHash,
        name: t?.name ?? rec.name,
        path: rec.path,
        addedAt: rec.addedAt,
        source: rec.source,
        error,
        partial: (rec.deselected?.length ?? 0) > 0,
        tracks: rec.tracks,
      }
      if (!t) {
        return {
          ...base,
          state: error ? 'error' : rec.done ? 'done' : 'paused',
          progress: rec.done ? 1 : 0,
          length: 0,
          downloaded: 0,
          uploaded: 0,
          downloadSpeed: 0,
          uploadSpeed: 0,
          numPeers: 0,
          timeRemaining: 0,
        }
      }
      // Progress and size over the selected files only
      const selected = t.ready ? this.selectedFiles(t, rec) : []
      const length = selected.reduce((s, f) => s + f.length, 0)
      const downloaded = selected.reduce((s, f) => s + f.downloaded, 0)
      const progress = length ? Math.min(1, downloaded / length) : t.progress
      const remaining = Math.max(0, length - downloaded)
      return {
        ...base,
        state: !t.ready ? 'metadata' : rec.done ? 'seeding' : 'downloading',
        progress,
        length,
        downloaded,
        uploaded: t.uploaded,
        downloadSpeed: t.downloadSpeed,
        uploadSpeed: t.uploadSpeed,
        numPeers: t.numPeers,
        timeRemaining: rec.done || !t.downloadSpeed ? 0 : (remaining / t.downloadSpeed) * 1000,
      }
    })
  }

  async pauseAll() {
    for (const r of this.records()) if (!r.paused) await this.pause(r.infoHash)
  }

  async resumeAll() {
    for (const r of this.records()) if (r.paused) await this.resume(r.infoHash)
  }

  /** Active (not paused, not finished) transfers, for the tray tooltip. */
  activeCount(): number {
    return this.records().filter((r) => !r.paused && !r.done).length
  }

  async destroy() {
    await this.saveDhtNodes()
    await new Promise<void>((resolve) => this.client.destroy(() => resolve()))
  }
}
