import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

// The BitTorrent engine: rqbit (Rust, Apache-2.0, github.com/ikatson/rqbit) running as a
// child process with its HTTP API on 127.0.0.1. Native code does the peer wire, hashing
// and disk I/O, so downloads run at the speed of the network instead of a JS event loop
// (WebTorrent, used before, reached ~1/3 of the speed with 1.2 GB of RAM and two cores).

export interface EngineFile {
  name: string
  components: string[]
  length: number
  included: boolean
}

export interface EngineStats {
  state: 'initializing' | 'live' | 'paused' | 'error'
  file_progress: number[]
  error?: string | null
  progress_bytes: number
  uploaded_bytes: number
  total_bytes: number
  finished: boolean
  live?: {
    snapshot?: { peer_stats?: { live?: number } }
    download_speed?: { mbps: number }
    upload_speed?: { mbps: number }
    time_remaining?: { duration?: { secs: number } } | null
  } | null
}

export interface EngineTorrent {
  info_hash: string
  name?: string | null
  output_folder: string
  files?: EngineFile[]
  stats?: EngineStats
}

export interface EngineOptions {
  /** rqbit executable */
  binary: string
  /** Session state (resume data) */
  dataDir: string
  /** Folder for torrents added without one */
  defaultFolder: string
  /** Incoming peer connections (TCP and uTP) */
  listenPort: number
  /** Announced on every torrent besides its own trackers */
  trackers: string[]
  /** Extra global flags (tests turn off DHT etc.) */
  extraArgs?: string[]
  log?: (msg: string) => void
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })

export class Engine {
  private proc?: ChildProcess
  private base = ''
  private stopping = false
  private ready?: Promise<void>
  /** Called after the engine (re)started, so the caller can re-sync its torrents */
  onRestart?: () => void

  constructor(private readonly opts: EngineOptions) {}

  private log(msg: string) {
    this.opts.log?.(`engine: ${msg}`)
  }

  start(): Promise<void> {
    this.ready ??= this.launch()
    return this.ready
  }

  private async launch() {
    mkdirSync(this.opts.dataDir, { recursive: true })
    const trackersFile = join(this.opts.dataDir, 'trackers.txt')
    writeFileSync(trackersFile, this.opts.trackers.join('\n') + '\n')
    const apiPort = await freePort()
    this.base = `http://127.0.0.1:${apiPort}`
    const args = [
      '-v', 'warn',
      '--http-api-listen-addr', `127.0.0.1:${apiPort}`,
      '--listen-port', String(this.opts.listenPort),
      // uTP reaches peers TCP can't (behind NAT, uTP-only clients): on a 70-seed torrent
      // behind carrier NAT, 12 live peers instead of 8
      '--experimental-enable-utp-listen',
      '--trackers-filename', trackersFile,
      ...(this.opts.extraArgs ?? []),
      'server', 'start',
      '--persistence-location', join(this.opts.dataDir, 'session'),
      '--fastresume',
      this.opts.defaultFolder,
    ]
    const proc = spawn(this.opts.binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.proc = proc
    const tail = (d: Buffer) => {
      for (const raw of d.toString().split(/\r?\n/)) {
        // Strip terminal colours; skip a tracker that answers with ICMP every few minutes
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
        if (!line || /tracker_comms_udp.*recv_from/.test(line)) continue
        this.log(line.slice(0, 500))
      }
    }
    proc.stdout?.on('data', tail)
    proc.stderr?.on('data', tail)
    proc.once('exit', (code) => {
      if (this.proc !== proc) return
      this.proc = undefined
      this.ready = undefined
      if (this.stopping) return
      this.log(`exited with ${code}, restarting`)
      setTimeout(() => void this.start().then(() => this.onRestart?.()).catch((e) => this.log(`restart failed: ${e.message}`)), 2000)
    })
    const spawnError = new Promise<never>((_, reject) => proc.once('error', reject))
    // Wait for the API to answer
    for (let i = 0; i < 150; i++) {
      try {
        const res = await Promise.race([fetch(`${this.base}/`, { signal: AbortSignal.timeout(1000) }), spawnError])
        if (res.ok) return
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error(`Torrent engine not found: ${this.opts.binary}`)
      }
      if (proc.exitCode !== null) throw new Error(`Torrent engine exited with code ${proc.exitCode}`)
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error('Torrent engine did not start')
  }

  async stop() {
    this.stopping = true
    const proc = this.proc
    if (!proc || proc.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000)
      proc.once('exit', () => (clearTimeout(timer), resolve()))
      proc.kill()
    })
  }

  private async call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    await this.start()
    const res = await fetch(this.base + path, { ...init, signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 30_000) })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let message = text
      try {
        message = (JSON.parse(text) as { human_readable?: string; error_kind?: string }).human_readable ?? text
      } catch {
        /* plain text */
      }
      throw new Error(message || `${res.status} ${res.statusText}`)
    }
    return res
  }

  private async json<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    return (await (await this.call(path, init)).json()) as T
  }

  async list(): Promise<EngineTorrent[]> {
    return (await this.json<{ torrents: EngineTorrent[] }>('/torrents?with_stats=true')).torrents
  }

  details(hash: string): Promise<EngineTorrent> {
    return this.json(`/torrents/${hash}`)
  }

  /** Adds a .torrent (bytes) or a magnet; returns the engine's view of it */
  async add(source: Uint8Array | string, opts: { outputFolder: string; onlyFiles?: number[] }): Promise<EngineTorrent> {
    const qs = new URLSearchParams({ overwrite: 'true', output_folder: opts.outputFolder })
    if (opts.onlyFiles?.length) qs.set('only_files', opts.onlyFiles.join(','))
    const body = typeof source === 'string' ? source : Buffer.from(source)
    const res = await this.json<{ details: EngineTorrent }>(`/torrents?${qs}`, { method: 'POST', body, timeoutMs: 600_000 })
    return res.details
  }

  /** .torrent bytes for a magnet; waits until a peer sends the metadata */
  async resolveMagnet(magnet: string, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.call('/torrents/resolve_magnet', { method: 'POST', body: magnet, signal, timeoutMs: 600_000 })
    return new Uint8Array(await res.arrayBuffer())
  }

  async pause(hash: string) {
    await this.call(`/torrents/${hash}/pause`, { method: 'POST' })
  }

  async resume(hash: string) {
    await this.call(`/torrents/${hash}/start`, { method: 'POST' })
  }

  /** Remove from the session; deleteFiles also removes the downloaded data */
  async remove(hash: string, deleteFiles: boolean) {
    await this.call(`/torrents/${hash}/${deleteFiles ? 'delete' : 'forget'}`, { method: 'POST' })
  }

  async setOnlyFiles(hash: string, files: number[]) {
    await this.call(`/torrents/${hash}/update_only_files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ only_files: files }),
    })
  }

  /** Bytes per second, 0 = unlimited */
  async setLimits(downloadBps: number, uploadBps: number) {
    await this.call('/torrents/limits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ download_bps: downloadBps > 0 ? downloadBps : null, upload_bps: uploadBps > 0 ? uploadBps : null }),
    })
  }

  /** Connect to these peers ("ip:port") right away */
  async addPeers(hash: string, peers: string[]) {
    await this.call(`/torrents/${hash}/add_peers`, { method: 'POST', body: peers.join('\n') })
  }

  /** Bytes [start, end] of a file; the engine fetches the needed pieces first */
  async readRange(hash: string, fileIndex: number, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.call(`/torrents/${hash}/stream/${fileIndex}`, { headers: { Range: `bytes=${start}-${end}` }, signal, timeoutMs: 180_000 })
    return new Uint8Array(await res.arrayBuffer())
  }
}
