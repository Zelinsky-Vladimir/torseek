// Minimal typings for the parts of WebTorrent / parse-torrent we use (neither ships types).

declare module 'webtorrent' {
  import { EventEmitter } from 'node:events'

  export interface TorrentFile extends EventEmitter {
    name: string
    path: string
    length: number
    progress: number
    downloaded: number
    done: boolean
    select(priority?: number): void
    deselect(): void
    /** Downloads the needed pieces first; async-iterable chunks */
    createReadStream(opts?: { start?: number; end?: number }): AsyncIterable<Uint8Array>
  }

  export interface Torrent extends EventEmitter {
    infoHash: string
    name: string
    ready: boolean
    done: boolean
    progress: number
    length?: number
    downloaded: number
    uploaded: number
    downloadSpeed: number
    uploadSpeed: number
    numPeers: number
    timeRemaining: number
    files: TorrentFile[]
    pieces: unknown[]
    select(start: number, end: number, priority?: number): void
    deselect(start: number, end: number): void
    torrentFile?: Uint8Array
    destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void
  }

  namespace WebTorrent {
    interface Instance extends EventEmitter {
      torrents: Torrent[]
      dht?: unknown
      add(torrentId: string | Uint8Array, opts?: { path?: string; deselect?: boolean; announce?: string[] }, onTorrent?: (t: Torrent) => void): Torrent
      throttleDownload(rate: number): void
      throttleUpload(rate: number): void
      destroy(cb?: (err?: Error) => void): void
    }
  }

  const WebTorrent: { new (opts?: Record<string, unknown>): WebTorrent.Instance }
  export default WebTorrent
}

declare module 'parse-torrent' {
  interface ParsedTorrent {
    infoHash?: string
    name?: string | Uint8Array
  }
  export default function parseTorrent(torrentId: string | Uint8Array): Promise<ParsedTorrent>
}
