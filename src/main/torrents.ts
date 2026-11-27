import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import parseTorrent from 'parse-torrent'
import type { DownloadTarget } from '../core/indexer'
import { magnetToInfoHash } from '../core/release'
import { externalSubtitles, mainVideo, readMediaTracks, type MediaTracks } from '../core/media-tracks'
import type { Connectivity, TorrentFileInfo, TorrentInfo } from '../shared/api'
import { Engine, type EngineTorrent } from './engine'
import type { JsonStore } from './store'

// The download list. Our records (torseek.json) are the source of truth: what the user
// added, where it goes, paused or not, which files. The engine (rqbit, see engine.ts) does
// the transfers and keeps its own resume data; on start and after an engine restart the
// two are reconciled. Every torrent's .torrent is kept in metaDir, so a magnet resolves
// only once.
//
// Folder layout matches every other client (and what the old engine wrote): a multi-file
// torrent goes into <folder>/<torrent name>/, a single-file one straight into <folder>.

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
  /** Bytes uploaded over all sessions */
  uploaded?: number
  /** Paused by the seeding limit (not by the user) */
  seedLimitReached?: boolean
  /** The user resumed it after the limit: seed without one */
  ignoreSeedLimit?: boolean
}

export interface TorrentStoreShape {
  torrents: TorrentRecord[]
  /** Port for incoming peer connections, picked once */
  listenPort?: number
}

export interface TorrentManagerOptions {
  /** rqbit executable */
  engineBinary: string
  /** Engine session data */
  engineDir: string
  defaultFolder: () => string
  seedAfterDownload: () => boolean
  /** Stop seeding at this upload/size ratio (0 = no limit) and after this many hours (0 = none) */
  seedLimits?: () => { ratio: number; hours: number }
  /** Downloads running at once; the rest wait in a queue (0 = no limit) */
  maxActiveDownloads?: () => number
  /** Called once when every selected file of a torrent has finished */
  onComplete?: (rec: TorrentRecord) => void
  /** Called after each status poll */
  onUpdate?: () => void
  /** Extra engine flags */
  engineArgs?: string[]
}

// Added to every torrent, as most clients do: magnets from index sites often list only
// trackers that died years ago, and then the metadata never arrives
export const PUBLIC_TRACKERS = [
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

interface Meta {
  name: string
  files: { path: string; length: number }[]
  /** Multi-file mode: files live in a folder named after the torrent, even if there is only one */
  multi: boolean
}

export class TorrentManager {
  private engine: Engine
  /** Latest engine view per info hash */
  private live = new Map<string, EngineTorrent>()
  /** Parsed .torrent per info hash */
  private metas = new Map<string, Meta>()
  private errors = new Map<string, string>()
  /** Magnets waiting for metadata */
  private resolving = new Map<string, AbortController>()
  private poller?: ReturnType<typeof setInterval>
  /** Downloads waiting for a free slot */
  private queued = new Set<string>()
  /** Engine's per-session upload counter last seen, to add only the difference */
  private lastUploaded = new Map<string, number>()
  private syncing?: Promise<void>

  constructor(
    private readonly store: JsonStore<TorrentStoreShape>,
    private readonly metaDir: string,
    private readonly opts: TorrentManagerOptions,
    private readonly log: (msg: string) => void = () => {},
  ) {
    let port = store.get().listenPort
    if (!port) {
      port = 20000 + Math.floor(Math.random() * 40000)
      store.update((d) => (d.listenPort = port))
    }
    this.engine = new Engine({
      binary: opts.engineBinary,
      dataDir: opts.engineDir,
      defaultFolder: opts.defaultFolder(),
      listenPort: port,
      trackers: PUBLIC_TRACKERS,
      extraArgs: opts.engineArgs,
      onPortChange: (p) => store.update((d) => (d.listenPort = p)),
      log,
    })
    this.engine.onRestart = () => void this.sync()
  }

  async init() {
    await mkdir(this.metaDir, { recursive: true })
    // Leftovers of the old engine and of interrupted track probes
    await rm(join(this.metaDir, 'probe'), { recursive: true, force: true }).catch(() => {})
    await rm(join(this.metaDir, 'dht-nodes.json'), { force: true }).catch(() => {})
    for (const rec of this.records()) await this.loadMeta(rec.infoHash)
    await this.engine.start()
    await this.sync()
    this.poller = setInterval(() => void this.poll(), 1000)
  }

  private records(): TorrentRecord[] {
    return this.store.get().torrents
  }

  private record(infoHash: string): TorrentRecord {
    const rec = this.records().find((r) => r.infoHash === infoHash)
    if (!rec) throw new Error(`Unknown torrent ${infoHash}`)
    return rec
  }

  private find(infoHash: string) {
    return this.records().find((r) => r.infoHash === infoHash)
  }

  private patch(infoHash: string, patch: Partial<TorrentRecord>) {
    const rec = this.find(infoHash)
    if (rec) this.store.update(() => Object.assign(rec, patch))
  }

  private metaFile(infoHash: string) {
    return join(this.metaDir, `${infoHash}.torrent`)
  }

  private async loadMeta(infoHash: string): Promise<Uint8Array | undefined> {
    try {
      const data = await readFile(this.metaFile(infoHash))
      if (!this.metas.has(infoHash)) this.metas.set(infoHash, await metaOf(data))
      return data
    } catch {
      return undefined
    }
  }

  /** Where the engine writes a torrent: <path>/<name>/ for multi-file torrents */
  private outputFolder(rec: TorrentRecord, meta: Meta) {
    return meta.multi ? join(rec.path, safeName(meta.name)) : rec.path
  }

  /** The engine holds the torrent with another folder than ours (e.g. added by 0.2.13) */
  private misplaced(rec: TorrentRecord, t: EngineTorrent) {
    const meta = this.metas.get(rec.infoHash)
    return !!meta && samePath(t.output_folder, this.outputFolder(rec, meta)) === false
  }

  // --- Reconciling records with the engine ---

  /** Make the engine hold exactly our torrents, in the right state */
  private sync(): Promise<void> {
    this.syncing ??= this.doSync().finally(() => (this.syncing = undefined))
    return this.syncing
  }

  private async doSync() {
    let engineList: EngineTorrent[]
    try {
      engineList = await this.engine.list()
    } catch (e) {
      this.log(`engine list: ${(e as Error).message}`)
      return
    }
    const ours = new Set(this.records().map((r) => r.infoHash))
    for (const t of engineList) {
      if (!ours.has(t.info_hash)) await this.engine.remove(t.info_hash, false).catch(() => {})
    }
    const inEngine = new Map(engineList.map((t) => [t.info_hash, t]))
    for (const rec of this.records()) {
      const t = inEngine.get(rec.infoHash)
      if (!t) {
        await this.startInEngine(rec)
        continue
      }
      if (this.misplaced(rec, t)) {
        this.log(`${rec.infoHash}: engine folder ${t.output_folder}, re-adding`)
        await this.engine.remove(rec.infoHash, false).catch(() => {})
        await this.startInEngine(rec)
        continue
      }
      this.live.set(rec.infoHash, t)
      const state = t.stats?.state
      if (rec.paused && (state === 'live' || state === 'initializing')) await this.engine.pause(rec.infoHash).catch(() => {})
      if (!rec.paused && state === 'paused' && !this.queued.has(rec.infoHash)) await this.engine.resume(rec.infoHash).catch(() => {})
    }
    await this.applyQueue()
  }

  /** Adds a record's torrent to the engine; magnets first resolve to a .torrent */
  private async startInEngine(rec: TorrentRecord) {
    let data = await this.loadMeta(rec.infoHash)
    if (!data) {
      if (!rec.magnet || this.resolving.has(rec.infoHash)) return
      const ctrl = new AbortController()
      this.resolving.set(rec.infoHash, ctrl)
      try {
        data = await this.engine.resolveMagnet(rec.magnet, ctrl.signal)
        await writeFile(this.metaFile(rec.infoHash), data)
        await this.loadMeta(rec.infoHash)
      } catch (e) {
        if (!ctrl.signal.aborted) this.errors.set(rec.infoHash, (e as Error).message)
        return
      } finally {
        this.resolving.delete(rec.infoHash)
      }
      if (!this.find(rec.infoHash)) return // removed while resolving
    }
    const meta = this.metas.get(rec.infoHash)!
    if (meta.name && meta.name !== rec.name) this.patch(rec.infoHash, { name: meta.name })
    const onlyFiles = rec.deselected?.length ? meta.files.map((_, i) => i).filter((i) => !rec.deselected!.includes(i)) : undefined
    try {
      const t = await this.engine.add(data, { outputFolder: this.outputFolder(rec, meta), onlyFiles })
      this.live.set(rec.infoHash, t)
      this.errors.delete(rec.infoHash)
      if (this.find(rec.infoHash)?.paused) await this.engine.pause(rec.infoHash).catch(() => {})
    } catch (e) {
      this.errors.set(rec.infoHash, (e as Error).message)
      this.log(`add ${rec.infoHash}: ${(e as Error).message}`)
    }
  }

  private polling = false
  private async poll() {
    if (this.polling) return
    this.polling = true
    try {
      const list = await this.engine.list()
      const seen = new Set<string>()
      for (const t of list) {
        seen.add(t.info_hash)
        const prev = this.live.get(t.info_hash)
        // The list has stats but not files; keep the file list from earlier
        this.live.set(t.info_hash, { ...prev, ...t, files: t.files ?? prev?.files })
        if (!t.files && !prev?.files) void this.engine.details(t.info_hash).then((d) => this.live.set(t.info_hash, { ...this.live.get(t.info_hash)!, files: d.files }))
        const err = t.stats?.state === 'error' ? (t.stats.error ?? 'Error') : undefined
        if (err) this.errors.set(t.info_hash, err)
        else if (this.errors.has(t.info_hash) && !this.resolving.has(t.info_hash)) this.errors.delete(t.info_hash)
        this.countUpload(t)
        this.smoothSpeed(t)
        this.checkComplete(t.info_hash)
        this.checkSeedLimit(t.info_hash)
      }
      await this.applyQueue()
      for (const h of [...this.live.keys()]) if (!seen.has(h)) this.live.delete(h)
      // Records the engine lost (crash, deleted session): add them again
      if (this.records().some((r) => !seen.has(r.infoHash) && !this.resolving.has(r.infoHash) && !this.errors.has(r.infoHash))) void this.sync()
      this.opts.onUpdate?.()
    } catch (e) {
      this.log(`poll: ${(e as Error).message}`)
    } finally {
      this.polling = false
    }
  }

  private checkComplete(infoHash: string) {
    const t = this.live.get(infoHash)
    const rec = this.find(infoHash)
    if (!t?.stats || !rec) return
    const complete = t.stats.finished && t.stats.total_bytes > 0
    if (complete && !rec.done) {
      this.patch(infoHash, { done: true, completedAt: Date.now() })
      this.opts.onComplete?.(rec)
      if (!this.opts.seedAfterDownload()) void this.pause(infoHash)
      void this.detectTracksFor(infoHash)
    } else if (!complete && rec.done && t.stats.state === 'live') {
      // More files were selected after completion
      this.patch(infoHash, { done: false })
    }
    if (!rec.tracks && t.stats.state === 'live') void this.detectTracksFor(infoHash)
  }

  /** Speeds averaged over a few seconds, as other clients show them */
  private speeds = new Map<string, { down: number; up: number }>()

  private smoothSpeed(t: EngineTorrent) {
    // The engine reports an instant rate that swings 1-12 MB/s second to second when
    // few peers are connected; an exponential average over ~5 s (one poll per second)
    const down = (t.stats?.live?.download_speed?.mbps ?? 0) * 1024 * 1024
    const up = (t.stats?.live?.upload_speed?.mbps ?? 0) * 1024 * 1024
    const prev = this.speeds.get(t.info_hash)
    const k = 0.2
    this.speeds.set(t.info_hash, prev && t.stats?.live ? { down: prev.down + k * (down - prev.down), up: prev.up + k * (up - prev.up) } : { down, up })
  }

  private countUpload(t: EngineTorrent) {
    const now = t.stats?.uploaded_bytes ?? 0
    const before = this.lastUploaded.get(t.info_hash)
    this.lastUploaded.set(t.info_hash, now)
    // First look, or the engine restarted and its counter began again
    const delta = before === undefined ? 0 : now >= before ? now - before : now
    if (delta <= 0) return
    // Kept in memory and written now and then, not on every second of seeding
    const pending = (this.pendingUpload.get(t.info_hash) ?? 0) + delta
    this.pendingUpload.set(t.info_hash, pending)
    if (pending >= 16 * 1024 * 1024) this.flushUpload(t.info_hash)
  }

  private pendingUpload = new Map<string, number>()

  private flushUpload(infoHash: string) {
    const pending = this.pendingUpload.get(infoHash) ?? 0
    this.pendingUpload.delete(infoHash)
    const rec = this.find(infoHash)
    if (rec && pending > 0) this.patch(infoHash, { uploaded: (rec.uploaded ?? 0) + pending })
  }

  /** All-time upload of a torrent */
  private uploadedOf(rec: TorrentRecord) {
    return (rec.uploaded ?? 0) + (this.pendingUpload.get(rec.infoHash) ?? 0)
  }

  private selectedSize(rec: TorrentRecord) {
    const meta = this.metas.get(rec.infoHash)
    return meta ? meta.files.reduce((n, f, i) => n + (rec.deselected?.includes(i) ? 0 : f.length), 0) : 0
  }

  private checkSeedLimit(infoHash: string) {
    const rec = this.find(infoHash)
    const limits = this.opts.seedLimits?.()
    if (!rec?.done || rec.paused || rec.ignoreSeedLimit || !limits) return
    const size = this.selectedSize(rec)
    const ratioHit = limits.ratio > 0 && size > 0 && this.uploadedOf(rec) / size >= limits.ratio
    const timeHit = limits.hours > 0 && !!rec.completedAt && Date.now() - rec.completedAt >= limits.hours * 3600_000
    if (ratioHit || timeHit) {
      this.log(`${infoHash}: seeding limit reached`)
      this.patch(infoHash, { seedLimitReached: true })
      void this.pause(infoHash)
    }
  }

  /** Oldest unfinished downloads run, up to the limit; the rest are paused in the engine */
  private async applyQueue() {
    const max = this.opts.maxActiveDownloads?.() ?? 0
    const waiting = this.records()
      .filter((r) => !r.paused && !r.done)
      .sort((a, b) => a.addedAt - b.addedAt)
    const queued = new Set(max > 0 ? waiting.slice(max).map((r) => r.infoHash) : [])
    for (const r of waiting) {
      const state = this.live.get(r.infoHash)?.stats?.state
      if (queued.has(r.infoHash) && (state === 'live' || state === 'initializing')) await this.engine.pause(r.infoHash).catch(() => {})
      if (!queued.has(r.infoHash) && state === 'paused') await this.engine.resume(r.infoHash).catch(() => {})
    }
    this.queued = queued
  }

  // --- Public API ---

  /** title names the torrent until its metadata arrives (magnets often have an empty dn) */
  async add(target: DownloadTarget, path: string, source?: TorrentRecord['source'], title?: string): Promise<{ infoHash: string }> {
    let infoHash: string
    let name: string
    let magnet: string | undefined
    if (target.kind === 'torrent') {
      const meta = await metaOf(target.data)
      infoHash = (await parseTorrent(Buffer.from(target.data))).infoHash!
      name = meta.name || title || infoHash
      await mkdir(this.metaDir, { recursive: true })
      await writeFile(this.metaFile(infoHash), target.data)
      this.metas.set(infoHash, meta)
    } else {
      magnet = target.uri
      infoHash = magnetToInfoHash(target.uri) ?? ''
      if (!/^[0-9a-f]{40}$/.test(infoHash)) throw new Error('Unsupported magnet link')
      name = new URLSearchParams(target.uri.split('?')[1]).get('dn') || title || infoHash
    }

    const existing = this.find(infoHash)
    if (existing) {
      if (existing.paused) await this.resume(infoHash)
      return { infoHash }
    }
    const rec: TorrentRecord = { infoHash, name, magnet, path, addedAt: Date.now(), paused: false, done: false, source }
    this.store.update((d) => d.torrents.unshift(rec))
    void this.startInEngine(rec).then(() => this.opts.onUpdate?.())
    return { infoHash }
  }

  async addMagnet(uri: string, path: string) {
    return this.add({ kind: 'magnet', uri }, path)
  }

  async pause(infoHash: string) {
    this.patch(infoHash, { paused: true })
    if (this.live.has(infoHash)) await this.engine.pause(infoHash).catch((e) => this.log(`pause: ${e.message}`))
  }

  async resume(infoHash: string) {
    const rec = this.find(infoHash)
    // Resuming a torrent the seeding limit stopped: the user wants it to seed on
    this.patch(infoHash, { paused: false, ...(rec?.seedLimitReached ? { seedLimitReached: false, ignoreSeedLimit: true } : {}) })
    this.errors.delete(infoHash)
    if (this.live.has(infoHash)) await this.engine.resume(infoHash)
    else await this.startInEngine(this.record(infoHash))
  }

  async pauseAll() {
    for (const r of this.records()) if (!r.paused) await this.pause(r.infoHash)
  }

  async resumeAll() {
    for (const r of this.records()) if (r.paused) await this.resume(r.infoHash)
  }

  async remove(infoHash: string, deleteFiles: boolean) {
    const rec = this.record(infoHash)
    this.resolving.get(infoHash)?.abort()
    const meta = this.metas.get(infoHash)
    this.store.update((d) => {
      d.torrents = d.torrents.filter((r) => r.infoHash !== infoHash)
    })
    if (this.live.has(infoHash)) await this.engine.remove(infoHash, deleteFiles).catch((e) => this.log(`remove: ${e.message}`))
    else if (deleteFiles && meta) {
      if (meta.multi) await rm(this.outputFolder(rec, meta), { recursive: true, force: true })
      else await rm(join(rec.path, meta.files[0].path), { force: true })
    }
    // rqbit deletes the files but leaves the torrent's folder
    if (deleteFiles && meta && meta.multi) await rm(this.outputFolder(rec, meta), { recursive: true, force: true }).catch(() => {})
    this.live.delete(infoHash)
    this.metas.delete(infoHash)
    this.errors.delete(infoHash)
    await rm(this.metaFile(infoHash), { force: true })
  }

  /** Choose which files to download (indexes into the torrent's file list). */
  async setFileSelection(infoHash: string, selected: number[]) {
    const meta = this.metas.get(infoHash)
    if (!meta) return
    if (!selected.length) throw new Error('Select at least one file')
    const deselected = meta.files.map((_, i) => i).filter((i) => !selected.includes(i))
    this.patch(infoHash, { deselected })
    if (this.live.has(infoHash)) await this.engine.setOnlyFiles(infoHash, selected)
  }

  contentPath(infoHash: string): string {
    const rec = this.record(infoHash)
    const meta = this.metas.get(infoHash)
    if (!meta) return rec.path
    return meta.multi ? this.outputFolder(rec, meta) : join(rec.path, meta.files[0].path)
  }

  filePath(infoHash: string, index: number): string {
    const rec = this.record(infoHash)
    const meta = this.metas.get(infoHash)
    const file = meta?.files[index]
    if (!meta || !file) throw new Error('File not available (torrent paused or metadata missing)')
    return join(meta.multi ? this.outputFolder(rec, meta) : rec.path, file.path)
  }

  files(infoHash: string): TorrentFileInfo[] {
    const rec = this.find(infoHash)
    const meta = this.metas.get(infoHash)
    if (!rec || !meta) return []
    const progress = this.live.get(infoHash)?.stats?.file_progress
    return meta.files.map((f, index) => {
      const selected = !rec.deselected?.includes(index)
      const downloaded = progress?.[index] ?? (rec.done && selected ? f.length : 0)
      return {
        index,
        name: f.path.split('/').pop()!,
        path: meta.multi ? `${meta.name}/${f.path}` : f.path,
        length: f.length,
        downloaded,
        progress: f.length ? Math.min(1, downloaded / f.length) : 1,
        selected,
      }
    })
  }

  setLimits(downloadKBs: number, uploadKBs: number) {
    void this.engine.setLimits(downloadKBs * 1024, uploadKBs * 1024).catch((e) => this.log(`limits: ${e.message}`))
  }

  snapshot(): TorrentInfo[] {
    return this.records().map((rec) => {
      const t = this.live.get(rec.infoHash)
      const s = t?.stats
      const error = this.errors.get(rec.infoHash) ?? (s?.state === 'error' ? (s.error ?? 'Error') : undefined)
      const base = {
        infoHash: rec.infoHash,
        name: this.metas.get(rec.infoHash)?.name || rec.name,
        path: rec.path,
        addedAt: rec.addedAt,
        source: rec.source,
        error,
        partial: (rec.deselected?.length ?? 0) > 0,
        tracks: rec.tracks,
      }
      // Size and progress over the selected files (the engine counts whole pieces)
      const meta = this.metas.get(rec.infoHash)
      const picked = meta?.files.map((f, i) => ({ ...f, i })).filter((f) => !rec.deselected?.includes(f.i))
      const length = picked && s ? picked.reduce((n, f) => n + f.length, 0) : (s?.total_bytes ?? 0)
      const downloaded = picked && s?.file_progress?.length ? picked.reduce((n, f) => n + Math.min(f.length, s.file_progress[f.i] ?? 0), 0) : (s?.progress_bytes ?? 0)
      const live = s?.live
      const speed = this.speeds.get(rec.infoHash) ?? { down: 0, up: 0 }
      const downloadSpeed = speed.down
      const state: TorrentInfo['state'] = error
        ? 'error'
        : !s
          ? rec.paused
            ? 'paused'
            : 'metadata'
          : this.queued.has(rec.infoHash)
            ? 'queued'
            : rec.paused || s.state === 'paused'
              ? rec.done
                ? 'done'
                : 'paused'
            : s.state === 'initializing'
              ? 'checking'
              : rec.done
                ? 'seeding'
                : 'downloading'
      return {
        ...base,
        state,
        progress: length ? Math.min(1, downloaded / length) : rec.done ? 1 : 0,
        length,
        downloaded,
        uploaded: this.uploadedOf(rec),
        ratio: length ? this.uploadedOf(rec) / length : 0,
        downloadSpeed: state === 'downloading' || state === 'seeding' ? downloadSpeed : 0,
        uploadSpeed: state === 'downloading' || state === 'seeding' ? speed.up : 0,
        numPeers: state === 'downloading' || state === 'seeding' ? (live?.snapshot?.peer_stats?.live ?? 0) : 0,
        // From the averaged speed, so the estimate doesn't jump either
        timeRemaining: state === 'downloading' && downloadSpeed > 1024 ? (Math.max(0, length - downloaded) / downloadSpeed) * 1000 : 0,
      }
    })
  }

  /** How reachable we are: incoming connections other peers made since the engine started */
  async connectivity(): Promise<Connectivity> {
    const session = await this.engine.sessionStats()
    let incoming = 0
    for (const hash of this.live.keys()) {
      const peers = await this.engine.peerStats(hash).catch(() => ({}))
      for (const p of Object.values(peers)) incoming += p.counters?.incoming_connections ?? 0
    }
    return { listenPort: this.engine.listenPort, incoming, peers: session.peers?.live ?? 0, uptime: session.uptime_seconds }
  }

  /** Active (not paused, not finished) transfers, for the tray tooltip. */
  activeCount(): number {
    return this.records().filter((r) => !r.paused && !r.done).length
  }

  async destroy() {
    clearInterval(this.poller)
    for (const h of [...this.pendingUpload.keys()]) this.flushUpload(h)
    for (const c of this.resolving.values()) c.abort()
    await this.engine.stop()
  }

  // --- Tracks: what audio / subtitles the release really has ---

  private probes = new Map<string, Promise<MediaTracks>>()
  private detecting = new Set<string>()

  private async detectTracksFor(infoHash: string) {
    if (this.detecting.has(infoHash) || this.find(infoHash)?.tracks) return
    this.detecting.add(infoHash)
    try {
      const tracks = await this.readTracks(infoHash)
      if (tracks) this.patch(infoHash, { tracks })
    } catch (e) {
      this.log(`tracks ${infoHash}: ${(e as Error).message}`)
    } finally {
      this.detecting.delete(infoHash)
    }
  }

  /** Tracks of a torrent in the engine: the main video's header plus subtitle files next to it */
  private async readTracks(infoHash: string, signal?: AbortSignal): Promise<MediaTracks | undefined> {
    const meta = this.metas.get(infoHash)
    if (!meta) return undefined
    const files = meta.files.map((f, index) => ({ ...f, index }))
    const main = mainVideo(files)
    const external = externalSubtitles(files.map((f) => f.path))
    if (!main) return external.length ? { file: '', container: 'other', tracks: external } : undefined
    const found = await readMediaTracks(main.path, main.length, (start, end) => this.engine.readRange(infoHash, main.index, start, end, signal))
    return { ...found, tracks: [...found.tracks, ...external] }
  }

  async infoHashOf(target: DownloadTarget): Promise<string> {
    const hash = target.kind === 'torrent' ? (await parseTorrent(Buffer.from(target.data))).infoHash : magnetToInfoHash(target.uri)
    if (!hash || !/^[0-9a-f]{40}$/.test(hash)) throw new Error('Unsupported magnet link')
    return hash
  }

  /**
   * Tracks of a release without downloading it: get the metadata, fetch only the start
   * (and, for MP4, the end) of the main video, read its header, drop it. Torrents already
   * in the list are read in place.
   */
  probe(target: DownloadTarget, infoHash: string): Promise<MediaTracks> {
    const cached = this.probes.get(infoHash)
    if (cached) return cached
    const rec = this.find(infoHash)
    if (rec?.tracks) return Promise.resolve(rec.tracks)
    const run = async (): Promise<MediaTracks> => {
      const signal = AbortSignal.timeout(180_000)
      if (rec && this.live.has(infoHash)) {
        const t = await this.readTracks(infoHash, signal)
        if (!t) throw new Error('No video in this torrent')
        return t
      }
      const data =
        target.kind === 'torrent'
          ? target.data
          : await this.engine.resolveMagnet(target.uri, AbortSignal.timeout(90_000)).catch(() => {
              throw new Error('No peers sent the torrent in time')
            })
      const meta = await metaOf(data)
      this.metas.set(infoHash, meta)
      const files = meta.files.map((f, index) => ({ ...f, index }))
      const main = mainVideo(files)
      const external = externalSubtitles(files.map((f) => f.path))
      if (!main) {
        if (external.length) return { file: '', container: 'other', tracks: external }
        throw new Error('No video in this torrent')
      }
      const dir = join(this.metaDir, 'probe', infoHash)
      await this.engine.add(data, { outputFolder: dir, onlyFiles: [main.index] })
      try {
        const found = await readMediaTracks(main.path, main.length, (start, end) => this.engine.readRange(infoHash, main.index, start, end, signal)).catch(() => {
          throw new Error('No peers sent the video header in time')
        })
        return { ...found, tracks: [...found.tracks, ...external] }
      } finally {
        await this.engine.remove(infoHash, true).catch(() => {})
        if (!this.find(infoHash)) this.metas.delete(infoHash)
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
    const p = run()
    this.probes.set(infoHash, p)
    p.catch(() => this.probes.delete(infoHash))
    return p
  }
}

/** Name and files of a .torrent; paths use "/" and exclude the torrent's name */
async function metaOf(data: Uint8Array): Promise<Meta> {
  const parsed = (await parseTorrent(Buffer.from(data))) as unknown as {
    name?: string | Uint8Array
    files?: { path: string; length: number }[]
    info?: { files?: unknown[] }
  }
  const name = String(parsed.name ?? '')
  const files = (parsed.files ?? []).map((f) => {
    const parts = f.path.split(/[\\/]/)
    // parse-torrent prefixes multi-file paths with the torrent name
    if (parts.length > 1 && parts[0] === name) parts.shift()
    return { path: parts.join('/'), length: f.length }
  })
  return { name, files, multi: Array.isArray(parsed.info?.files) }
}

/** Same folder? (the engine reports Windows paths as \\?\C:\...) */
export function samePath(a: string, b: string) {
  const norm = (p: string) => {
    const s = p
      .replace(/^\\\\\?\\/, '')
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

/** Torrent names as folder names (the engine is given the folder, so it can't clean it up) */
function safeName(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'torrent'
}
