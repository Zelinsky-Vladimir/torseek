import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import WebTorrent from 'webtorrent'
import type { Torrent } from 'webtorrent'
import parseTorrent from 'parse-torrent'
import type { DownloadTarget } from '../core/cardigann/indexer'
import { magnetToInfoHash } from '../core/release'
import type { TorrentFileInfo, TorrentInfo } from '../shared/api'
import type { JsonStore } from './store'

// Built-in BitTorrent client on top of WebTorrent (pure JS: TCP, uTP, DHT, PEX, trackers).
// Every torrent is persisted as a record plus its .torrent metadata so downloads resume
// after a restart; WebTorrent re-verifies pieces already on disk.

export interface TorrentRecord {
  infoHash: string
  name: string
  magnet?: string
  path: string
  addedAt: number
  paused: boolean
  done: boolean
  source?: { indexerName: string; details?: string }
}

export interface TorrentStoreShape {
  torrents: TorrentRecord[]
}

export interface TorrentManagerOptions {
  seedAfterDownload: () => boolean
}

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
    this.client = new WebTorrent()
    this.client.on('error', (err) => this.log(`webtorrent: ${String(err)}`))
  }

  async init() {
    await mkdir(this.metaDir, { recursive: true })
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

  async add(target: DownloadTarget, path: string, source?: TorrentRecord['source']): Promise<{ infoHash: string }> {
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
      name = new URLSearchParams(target.uri.split('?')[1]).get('dn') ?? infoHash
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

    const torrent = this.client.add(torrentId, { path: rec.path })
    this.live.set(rec.infoHash, torrent)

    torrent.on('metadata', async () => {
      if (torrent.name && torrent.name !== rec.name) this.patch(rec.infoHash, { name: torrent.name })
      if (torrent.torrentFile) await writeFile(this.metaFile(rec.infoHash), torrent.torrentFile).catch(() => {})
    })
    torrent.on('done', () => {
      this.patch(rec.infoHash, { done: true })
      if (!this.opts.seedAfterDownload()) void this.pause(rec.infoHash)
    })
    torrent.on('error', (err) => {
      this.errors.set(rec.infoHash, String((err as Error)?.message ?? err))
      this.live.delete(rec.infoHash)
    })
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

  files(infoHash: string): TorrentFileInfo[] {
    const t = this.live.get(infoHash)
    if (!t) return []
    return t.files.map((f) => ({ name: f.name, path: f.path, length: f.length, progress: f.progress }))
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
      return {
        ...base,
        state: !t.ready ? 'metadata' : t.done ? 'seeding' : 'downloading',
        progress: t.progress,
        length: t.length ?? 0,
        downloaded: t.downloaded,
        uploaded: t.uploaded,
        downloadSpeed: t.downloadSpeed,
        uploadSpeed: t.uploadSpeed,
        numPeers: t.numPeers,
        timeRemaining: Number.isFinite(t.timeRemaining) ? t.timeRemaining : 0,
      }
    })
  }

  async destroy() {
    await new Promise<void>((resolve) => this.client.destroy(() => resolve()))
  }
}
