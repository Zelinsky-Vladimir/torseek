import { createSocket, type Socket } from 'node:dgram'
import { lookup } from 'node:dns/promises'

// Real seeder / leecher counts from public trackers (UDP scrape, BEP 15). Index sites
// show numbers they recorded whenever they last looked, often years ago; the big open
// trackers know who is announcing right now. One request covers up to 74 torrents.

export interface SwarmStats {
  seeders: number
  leechers: number
}

export const SCRAPE_TRACKERS = [
  'udp://tracker.opentrackr.org:1337',
  'udp://open.demonii.com:1337',
  'udp://tracker.torrent.eu.org:451',
  'udp://open.stealth.si:80',
]

const PROTOCOL_ID = 0x41727101980n
const BATCH = 70

function request(socket: Socket, host: string, port: number, packet: Buffer, transactionId: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('timeout'))
    }, timeoutMs)
    const onMessage = (msg: Buffer) => {
      if (msg.length < 8 || msg.readUInt32BE(4) !== transactionId) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      if (msg.readUInt32BE(0) === 3) reject(new Error(msg.subarray(8).toString()))
      else resolve(msg)
    }
    socket.on('message', onMessage)
    socket.send(packet, port, host, (err) => err && (clearTimeout(timer), socket.off('message', onMessage), reject(err)))
  })
}

/** Scrape one UDP tracker for many info hashes (40-char hex). Missing hashes = tracker didn't answer. */
export async function scrapeTracker(url: string, infoHashes: string[], timeoutMs = 4000): Promise<Map<string, SwarmStats>> {
  const { hostname, port } = new URL(url)
  const { address, family } = await lookup(hostname)
  const socket = createSocket(family === 6 ? 'udp6' : 'udp4')
  socket.on('error', () => {})
  const out = new Map<string, SwarmStats>()
  const tid = () => Math.floor(Math.random() * 0xffffffff)
  try {
    // connect: protocol id, action 0, transaction id -> connection id
    let t = tid()
    const connect = Buffer.alloc(16)
    connect.writeBigUInt64BE(PROTOCOL_ID, 0)
    connect.writeUInt32BE(0, 8)
    connect.writeUInt32BE(t, 12)
    const conn = await request(socket, address, Number(port), connect, t, timeoutMs)
    const connectionId = conn.subarray(8, 16)

    for (let i = 0; i < infoHashes.length; i += BATCH) {
      const batch = infoHashes.slice(i, i + BATCH)
      t = tid()
      const packet = Buffer.alloc(16 + 20 * batch.length)
      connectionId.copy(packet, 0)
      packet.writeUInt32BE(2, 8)
      packet.writeUInt32BE(t, 12)
      batch.forEach((h, j) => Buffer.from(h, 'hex').copy(packet, 16 + 20 * j))
      const res = await request(socket, address, Number(port), packet, t, timeoutMs)
      // per torrent: seeders, completed, leechers
      batch.forEach((h, j) => {
        const at = 8 + 12 * j
        if (at + 12 <= res.length) out.set(h, { seeders: res.readUInt32BE(at), leechers: res.readUInt32BE(at + 8) })
      })
    }
  } finally {
    socket.close()
  }
  return out
}

/** Best (largest) counts over several trackers; torrents no tracker answered for are left out. */
export async function scrapeAll(infoHashes: string[], trackers = SCRAPE_TRACKERS, timeoutMs?: number): Promise<Map<string, SwarmStats>> {
  const hashes = [...new Set(infoHashes.map((h) => h.toLowerCase()))].filter((h) => /^[0-9a-f]{40}$/.test(h))
  const merged = new Map<string, SwarmStats>()
  if (!hashes.length) return merged
  const results = await Promise.allSettled(trackers.map((url) => scrapeTracker(url, hashes, timeoutMs)))
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const [h, s] of r.value) {
      const prev = merged.get(h)
      merged.set(h, prev ? { seeders: Math.max(prev.seeders, s.seeders), leechers: Math.max(prev.leechers, s.leechers) } : s)
    }
  }
  return merged
}
