import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonStore } from '../src/main/store'
import { TorrentManager, type TorrentStoreShape } from '../src/main/torrents'
import type { Engine } from '../src/main/engine'

// Drives the real engine (rqbit from build/bin, `npm run engine`) against a second rqbit
// that seeds a local file. No internet: DHT, trackers, UPnP and LSD are off and the
// seeder is introduced as a peer directly.

const binary = join(__dirname, '..', 'build', 'bin', process.platform, process.platform === 'win32' ? 'rqbit.exe' : 'rqbit')
const OFFLINE = ['--disable-dht', '--disable-dht-persistence', '--disable-trackers', '--disable-upnp-port-forward', '--disable-lsd']
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function seeder(files: Record<string, Uint8Array>) {
  const dir = tmp('seed-')
  const root = join(dir, 'Movie')
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), data)
  }
  const port = 30000 + Math.floor(Math.random() * 20000)
  const api = port + 1
  const proc: ChildProcess = spawn(binary, [...OFFLINE, '--listen-port', String(port), '--http-api-listen-addr', `127.0.0.1:${api}`, 'share', Object.keys(files).length > 1 ? root : join(root, Object.keys(files)[0])], { stdio: 'ignore', windowsHide: true })
  cleanup.push(() => void proc.kill())
  for (let i = 0; i < 50; i++) {
    const list = await fetch(`http://127.0.0.1:${api}/torrents`).then((r) => r.json() as Promise<{ torrents: { info_hash: string }[] }>).catch(() => null)
    const hash = list?.torrents[0]?.info_hash
    if (hash) {
      const torrent = new Uint8Array(await (await fetch(`http://127.0.0.1:${api}/torrents/${hash}/metadata`)).arrayBuffer())
      return { hash, torrent, peer: `127.0.0.1:${port}` }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('seeder did not start')
}

async function manager(opts: { seed?: boolean } = {}) {
  const store = new JsonStore<TorrentStoreShape>(join(tmp('store-'), 's.json'), { torrents: [] })
  let completed = 0
  const mgr = new TorrentManager(store, tmp('meta-'), {
    engineBinary: binary,
    engineDir: tmp('engine-'),
    defaultFolder: () => tmpdir(),
    seedAfterDownload: () => !!opts.seed,
    onComplete: () => completed++,
    engineArgs: OFFLINE,
  })
  cleanup.push(() => mgr.destroy())
  await mgr.init()
  const engine = (mgr as unknown as { engine: Engine }).engine
  return { mgr, store, engine, completed: () => completed }
}

const until = async (cond: () => boolean, ms = 20_000) => {
  for (let t = 0; t < ms && !cond(); t += 200) await new Promise((r) => setTimeout(r, 200))
  return cond()
}

describe.skipIf(!existsSync(binary))('torrent manager (rqbit)', () => {
  it('downloads a multi-file torrent into <folder>/<name>/ and pauses when seeding is off', async () => {
    const a = randomBytes(700_000)
    const b = randomBytes(300_000)
    const s = await seeder({ 'video.mkv': a, 'Subs/en.srt': b })
    const { mgr, store, engine, completed } = await manager({ seed: false })
    const dest = tmp('dl-')
    await mgr.add({ kind: 'torrent', data: s.torrent }, dest, { indexerName: 'Test' })
    expect(await until(() => mgr.snapshot()[0]?.state !== 'metadata')).toBe(true)
    await engine.addPeers(s.hash, [s.peer])

    expect(await until(() => store.get().torrents[0]?.paused === true)).toBe(true)
    expect(completed()).toBe(1)
    expect(store.get().torrents[0]).toMatchObject({ name: 'Movie', done: true })
    expect(readFileSync(join(dest, 'Movie', 'video.mkv')).equals(a)).toBe(true)
    expect(readFileSync(join(dest, 'Movie', 'Subs', 'en.srt')).equals(b)).toBe(true)
    expect(mgr.contentPath(s.hash)).toBe(join(dest, 'Movie'))
    expect(mgr.files(s.hash).map((f) => `${f.path} ${f.progress}`).sort()).toEqual(['Movie/Subs/en.srt 1', 'Movie/video.mkv 1'])
    expect(mgr.snapshot()[0]).toMatchObject({ state: 'done', progress: 1 })
  }, 60_000)

  it('downloads only the selected files and deletes data on remove', async () => {
    const big = randomBytes(800_000)
    const small = randomBytes(100_000)
    const s = await seeder({ 'big.bin': big, 'small.bin': small })
    const { mgr, store, engine } = await manager({ seed: true })
    const dest = tmp('dl-')
    await mgr.add({ kind: 'torrent', data: s.torrent }, dest)
    const smallIndex = mgr.files(s.hash).findIndex((f) => f.path.endsWith('small.bin'))
    await mgr.setFileSelection(s.hash, [smallIndex])
    expect(await until(() => mgr.snapshot()[0]?.state !== 'metadata')).toBe(true)
    await engine.addPeers(s.hash, [s.peer])

    expect(await until(() => store.get().torrents[0]?.done === true)).toBe(true)
    expect(readFileSync(join(dest, 'Movie', 'small.bin')).equals(small)).toBe(true)
    expect(mgr.snapshot()[0]).toMatchObject({ partial: true, state: 'seeding' })
    expect(mgr.files(s.hash).find((f) => f.path.endsWith('big.bin'))?.selected).toBe(false)

    await mgr.remove(s.hash, true)
    expect(store.get().torrents).toEqual([])
    expect(existsSync(join(dest, 'Movie'))).toBe(false)
  }, 60_000)
})
