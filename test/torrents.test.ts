import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonStore } from '../src/main/store'
import { samePath, TorrentManager, type TorrentStoreShape } from '../src/main/torrents'
import type { Engine } from '../src/main/engine'

// Drives the real engine (rqbit from build/bin, `npm run engine`) against a second rqbit
// that seeds a local file. No internet: DHT, trackers, UPnP and LSD are off and the
// seeder is introduced as a peer directly.

const binary = join(__dirname, '..', 'build', 'bin', process.platform, process.platform === 'win32' ? 'rqbit.exe' : 'rqbit')
const OFFLINE = ['--disable-dht', '--disable-trackers', '--disable-upnp-port-forward', '--disable-lsd']
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function seeder(files: Record<string, Uint8Array>, { folder = Object.keys(files).length > 1 } = {}) {
  const dir = tmp('seed-')
  const root = join(dir, 'Movie')
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), data)
  }
  // A random port can land in a range Windows reserves (Hyper-V): the seeder then exits
  // at once and we try another
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = 30000 + Math.floor(Math.random() * 20000)
    const api = port + 1
    const proc: ChildProcess = spawn(binary, [...OFFLINE, '--listen-port', String(port), '--http-api-listen-addr', `127.0.0.1:${api}`, 'share', folder ? root : join(root, Object.keys(files)[0])], { stdio: 'ignore', windowsHide: true })
    cleanup.push(() => void proc.kill())
    for (let i = 0; i < 50 && proc.exitCode === null; i++) {
      const list = await fetch(`http://127.0.0.1:${api}/torrents`).then((r) => r.json() as Promise<{ torrents: { info_hash: string }[] }>).catch(() => null)
      const hash = list?.torrents[0]?.info_hash
      if (hash) {
        const torrent = new Uint8Array(await (await fetch(`http://127.0.0.1:${api}/torrents/${hash}/metadata`)).arrayBuffer())
        return { hash, torrent, peer: `127.0.0.1:${port}` }
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    proc.kill()
  }
  throw new Error('seeder did not start')
}

async function manager(
  opts: { seed?: boolean; dirs?: { store: string; meta: string; engine: string }; maxActive?: number; seedHours?: number } = {},
) {
  const dirs = opts.dirs ?? { store: tmp('store-'), meta: tmp('meta-'), engine: tmp('engine-') }
  const store = new JsonStore<TorrentStoreShape>(join(dirs.store, 's.json'), { torrents: [] })
  let completed = 0
  const mgr = new TorrentManager(store, dirs.meta, {
    engineBinary: binary,
    engineDir: dirs.engine,
    defaultFolder: () => tmpdir(),
    seedAfterDownload: () => !!opts.seed,
    onComplete: () => completed++,
    seedLimits: () => ({ ratio: 0, hours: opts.seedHours ?? 0 }),
    maxActiveDownloads: () => opts.maxActive ?? 0,
    engineArgs: OFFLINE,
  })
  cleanup.push(() => mgr.destroy())
  await mgr.init()
  const engine = (mgr as unknown as { engine: Engine }).engine
  return { mgr, store, engine, dirs, completed: () => completed }
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

  // A torrent in multi-file mode with a single file still lives in <folder>/<name>/;
  // 0.2.13 put such torrents straight into <folder> and re-downloaded finished movies.
  it('keeps one-file folder torrents in their folder and moves them back from the wrong one', async () => {
    const data = randomBytes(600_000)
    const s = await seeder({ 'Movie (2002).mkv': data }, { folder: true })
    const dest = tmp('dl-')
    // The finished download from before, where every client puts it
    mkdirSync(join(dest, 'Movie'), { recursive: true })
    writeFileSync(join(dest, 'Movie', 'Movie (2002).mkv'), data)

    const first = await manager()
    // What 0.2.13 did: the engine holds it with the parent folder
    await first.engine.add(s.torrent, { outputFolder: dest })
    first.store.update((d) => d.torrents.push({ infoHash: s.hash, name: 'Movie', path: dest, addedAt: Date.now(), paused: false, done: true }))
    await mkdir(first.dirs.meta, { recursive: true })
    writeFileSync(join(first.dirs.meta, `${s.hash}.torrent`), s.torrent)
    first.store.flush()
    await first.mgr.destroy()

    const { mgr, engine } = await manager({ seed: true, dirs: first.dirs })
    expect(mgr.contentPath(s.hash)).toBe(join(dest, 'Movie'))
    // Found the finished file where it is: complete without any peer
    expect(await until(() => mgr.snapshot()[0]?.state === 'seeding')).toBe(true)
    expect(mgr.snapshot()[0].progress).toBe(1)
    expect(samePath((await engine.details(s.hash)).output_folder, join(dest, 'Movie'))).toBe(true)
  }, 60_000)

  it('runs only as many downloads as allowed and starts the next when a slot frees up', async () => {
    const a = await seeder({ 'a.bin': randomBytes(200_000) })
    const b = await seeder({ 'b.bin': randomBytes(200_000) })
    const { mgr } = await manager({ maxActive: 1 })
    const dest = tmp('dl-')
    await mgr.add({ kind: 'torrent', data: a.torrent }, dest)
    await new Promise((r) => setTimeout(r, 20))
    await mgr.add({ kind: 'torrent', data: b.torrent }, dest)
    const state = (h: string) => mgr.snapshot().find((t) => t.infoHash === h)?.state
    // No peers yet: the first waits for data, the second for a slot
    expect(await until(() => state(b.hash) === 'queued' && state(a.hash) === 'downloading')).toBe(true)
    await mgr.remove(a.hash, true)
    expect(await until(() => state(b.hash) === 'downloading')).toBe(true)
  }, 60_000)

  it('stops seeding at the time limit and seeds on when the user resumes', async () => {
    const s = await seeder({ 'a.bin': randomBytes(200_000) })
    const { mgr, store, engine } = await manager({ seed: true, seedHours: 2 / 3600 })
    await mgr.add({ kind: 'torrent', data: s.torrent }, tmp('dl-'))
    expect(await until(() => mgr.snapshot()[0]?.state !== 'metadata')).toBe(true)
    await engine.addPeers(s.hash, [s.peer])
    expect(await until(() => store.get().torrents[0]?.done === true)).toBe(true)
    expect(await until(() => store.get().torrents[0]?.paused === true)).toBe(true)
    expect(store.get().torrents[0].seedLimitReached).toBe(true)
    await mgr.resume(s.hash)
    await new Promise((r) => setTimeout(r, 4000))
    expect(store.get().torrents[0]).toMatchObject({ paused: false, ignoreSeedLimit: true })
    expect(mgr.snapshot()[0].state).toBe('seeding')
  }, 60_000)

  it('moves to another port when its listen port is taken', async () => {
    const blocker = createServer().listen(0)
    await new Promise((r) => blocker.once('listening', r))
    cleanup.push(() => void blocker.close())
    const taken = (blocker.address() as { port: number }).port
    const dirs = { store: tmp('store-'), meta: tmp('meta-'), engine: tmp('engine-') }
    writeFileSync(join(dirs.store, 's.json'), JSON.stringify({ torrents: [], listenPort: taken }))
    const { store } = await manager({ dirs })
    expect(store.get().listenPort).not.toBe(taken)
  }, 60_000)
})

describe('samePath', () => {
  it('ignores the Windows long-path prefix, slashes and case', () => {
    expect(samePath(String.raw`\\?\E:\Movies\ `.trim(), String.raw`e:\movies`)).toBe(process.platform === 'win32')
    expect(samePath('/data/movies/', '/data/movies')).toBe(true)
    expect(samePath('/data/movies', '/data/movies/x')).toBe(false)
  })
})
