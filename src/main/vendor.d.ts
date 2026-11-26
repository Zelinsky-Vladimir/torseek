// Minimal typings for the parts of parse-torrent we use (it ships no types).

declare module 'parse-torrent' {
  interface ParsedTorrent {
    infoHash?: string
    name?: string | Uint8Array
  }
  export default function parseTorrent(torrentId: string | Uint8Array): Promise<ParsedTorrent>
}
