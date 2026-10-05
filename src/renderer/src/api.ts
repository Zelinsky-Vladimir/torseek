import type { Api, AppSettings, IndexerInfo, Release, SearchEvent, TorrentInfo } from '../../shared/api'

declare global {
  interface Window {
    api?: Api
  }
}

// In Electron the preload provides window.api. Opened in a plain browser (vite dev),
// we fall back to an in-memory mock so the UI can be worked on without the backend.
export const api: Api = window.api ?? createMockApi()
export const isMock = !window.api

function createMockApi(): Api {
  const searchListeners = new Set<(e: SearchEvent) => void>()
  const torrentListeners = new Set<(t: TorrentInfo[]) => void>()
  const names = ['RuTor', 'The Pirate Bay', 'LimeTorrents', 'NoNaMe-Club', 'TheRARBG', 'BigFANGroup', 'RuTracker.RU', 'YTS', 'TorrentGalaxyClone', 'Nyaa.si', 'Torrent9', 'MegaPeer']
  const indexers: IndexerInfo[] = names.map((name, i) => ({
    id: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
    name,
    description: `${name} is a public torrent tracker`,
    language: i % 3 === 0 ? 'ru-RU' : 'en-US',
    type: 'public',
    links: [`https://${name.toLowerCase().replace(/[^a-z0-9]/g, '')}.example/`],
    siteLink: `https://${name.toLowerCase().replace(/[^a-z0-9]/g, '')}.example/`,
    enabled: i < 10,
    categories: [2000, 5000, 3000].slice(0, (i % 3) + 1),
    settings: [
      { name: 'sort', type: 'select', label: 'Sort requested from site', default: 'time', options: { time: 'created', seeders: 'seeders', size: 'size' } },
      { name: 'freeleech', type: 'checkbox', label: 'Search freeleech only', default: false },
    ],
    values: {},
    health: i === 4 ? { state: 'blocked', at: Date.now() } : i === 7 ? { state: 'error', error: 'fetch failed (ECONNRESET)', at: Date.now() } : undefined,
  }))
  indexers.push({ ...indexers[0], id: 'privatetracker', name: 'SomePrivate', type: 'private', enabled: false, loginMethod: 'form', signedIn: false, settings: [{ name: 'username', type: 'text', label: 'Username' }, { name: 'password', type: 'password', label: 'Password' }], health: undefined })

  let settings: AppSettings = { closeToTray: true, notifyOnComplete: true, openAtLogin: false, language: 'auto', downloadDir: 'C:\\Users\\me\\Downloads\\Torseek', searchConcurrency: 12, searchTimeoutSec: 25, seedAfterDownload: true, showAdult: false, downloadLimit: 0, uploadLimit: 0 }
  const torrents: TorrentInfo[] = [
    { infoHash: 'a'.repeat(40), name: 'Dune.Part.Two.2024.2160p.WEB-DL.DV.HDR.H.265-FLUX', state: 'downloading', progress: 0.42, length: 18e9, downloaded: 7.5e9, uploaded: 1.2e9, downloadSpeed: 8.4e6, uploadSpeed: 4.1e5, numPeers: 63, timeRemaining: 1_250_000, path: settings.downloadDir, addedAt: Date.now() - 3e6, source: { indexerName: 'TheRARBG' } },
    { infoHash: 'b'.repeat(40), name: 'ubuntu-26.04.1-desktop-amd64.iso', state: 'seeding', progress: 1, length: 6.4e9, downloaded: 6.4e9, uploaded: 9.1e9, downloadSpeed: 0, uploadSpeed: 1.3e6, numPeers: 12, timeRemaining: 0, path: settings.downloadDir, addedAt: Date.now() - 9e7 },
    { infoHash: 'c'.repeat(40), name: 'Дюна: Часть вторая / Dune: Part Two (2024) WEB-DL 1080p', state: 'paused', progress: 0.08, length: 9.8e9, downloaded: 0.8e9, uploaded: 0, downloadSpeed: 0, uploadSpeed: 0, numPeers: 0, timeRemaining: 0, path: settings.downloadDir, addedAt: Date.now() - 6e5 },
  ]
  setInterval(() => {
    const t = torrents[0]
    if (t.state === 'downloading') t.progress = Math.min(1, t.progress + 0.002)
    torrentListeners.forEach((cb) => cb(structuredClone(torrents)))
  }, 1000)

  const titles = [
    ['Dune Part Two 2024 2160p WEB-DL DV HDR H 265-FLUX', 18.2e9, 2040],
    ['Dune.Part.Two.2024.1080p.BluRay.x264-SPARKS', 12.1e9, 2040],
    ['Дюна: Часть вторая / Dune: Part Two (2024) WEB-DL 1080p | Дубляж', 9.8e9, 2040],
    ['Dune Prophecy S01E04 1080p WEB H264-SuccessfulCrab', 3.4e9, 5040],
    ['Dune (2021) [720p] [BluRay] [YTS.MX]', 1.4e9, 2040],
    ['Dune Part Two 2024 1080p WEBRip x265 10bit AAC5 1', 2.6e9, 2040],
    ['Frank Herbert - Dune Chronicles (1-6) EPUB', 0.012e9, 7020],
    ['Hans Zimmer - Dune Part Two (Original Soundtrack) 2024 FLAC', 0.9e9, 3040],
    ['Dune Imperium Uprising v1.2 PC Game', 4.2e9, 4050],
    ['Dune Part Two 2024 HDCAM x264', 1.1e9, 2030],
  ] as const

  const mock = {
    async search({ searchId }: { searchId: string }) {
      const enabled = indexers.filter((i) => i.enabled)
      enabled.forEach((ix, i) => {
        const emit = (e: SearchEvent) => searchListeners.forEach((cb) => cb(e))
        emit({ type: 'status', searchId, status: { indexerId: ix.id, indexerName: ix.name, state: 'running' } })
        setTimeout(() => {
          if (i === 4) return emit({ type: 'status', searchId, status: { indexerId: ix.id, indexerName: ix.name, state: 'blocked', elapsedMs: 900 } })
          if (i === 7) return emit({ type: 'status', searchId, status: { indexerId: ix.id, indexerName: ix.name, state: 'error', error: 'fetch failed (ECONNRESET)', elapsedMs: 400 } })
          const releases: Release[] = titles.slice(0, 4 + (i % 6)).map(([title, size, cat], j) => ({
            indexerId: ix.id,
            indexerName: ix.name,
            title: title as string,
            guid: `${ix.id}-${j}`,
            details: `https://example.org/t/${j}`,
            magnet: `magnet:?xt=urn:btih:${String(j).repeat(40).slice(0, 40)}`,
            infoHash: j % 2 === 0 ? String(j).repeat(40).slice(0, 40) : undefined,
            size: size as number,
            seeders: Math.round(3000 / (j + 1) / (1 + (i % 3))),
            leechers: Math.round(400 / (j + 1)),
            publishDate: new Date(Date.now() - j * 86400000 * (i + 1)).toISOString(),
            categories: [cat as number],
          }))
          emit({ type: 'results', searchId, indexerId: ix.id, releases })
          emit({ type: 'status', searchId, status: { indexerId: ix.id, indexerName: ix.name, state: 'done', count: releases.length, elapsedMs: 300 + i * 180 } })
          if (i === enabled.length - 1) emit({ type: 'done', searchId, elapsedMs: 2400 })
        }, 300 + i * 180)
      })
      return { searchId }
    },
    async cancelSearch() {},
    onSearchEvent(cb: (e: SearchEvent) => void) {
      searchListeners.add(cb)
      return () => searchListeners.delete(cb)
    },
    async listIndexers() {
      return structuredClone(indexers)
    },
    async setIndexerEnabled(id: string, enabled: boolean) {
      const ix = indexers.find((i) => i.id === id)!
      ix.enabled = enabled
      return structuredClone(ix)
    },
    async updateIndexerSettings(id: string, values: IndexerInfo['values']) {
      const ix = indexers.find((i) => i.id === id)!
      ix.values = values
      return structuredClone(ix)
    },
    async signIn(id: string) {
      await new Promise((r) => setTimeout(r, 700))
      const ix = indexers.find((i) => i.id === id)!
      ix.signedIn = true
      return { ok: true, info: structuredClone(ix) }
    },
    async signInWithBrowser(id: string) {
      return mock.signIn(id)
    },
    async signOut(id: string) {
      const ix = indexers.find((i) => i.id === id)!
      ix.signedIn = false
      return structuredClone(ix)
    },
    async passChallenge(id: string) {
      await new Promise((r) => setTimeout(r, 1200))
      const ix = indexers.find((i) => i.id === id)!
      ix.health = undefined
      return { ok: true, info: structuredClone(ix) }
    },
    async definitionsStatus() {
      return { checkedAt: Date.now() - 3 * 3600_000, updating: false }
    },
    async updateDefinitions() {
      await new Promise((r) => setTimeout(r, 1500))
      return { checkedAt: Date.now(), updating: false, lastResult: { updated: 12, added: 1, removed: 0, total: 584 } }
    },
    onIndexersChanged() {
      return () => {}
    },
    async testIndexer(id: string) {
      await new Promise((r) => setTimeout(r, 800))
      const ix = indexers.find((i) => i.id === id)!
      ix.health = { state: 'done', count: 50, at: Date.now() }
      return structuredClone(ix)
    },
    async download(release: Release) {
      await new Promise((r) => setTimeout(r, 600))
      return { infoHash: release.infoHash ?? 'f'.repeat(40) }
    },
    async getMagnet(release: Release) {
      return release.magnet ?? ''
    },
    async addMagnet() {
      return { infoHash: 'e'.repeat(40) }
    },
    async listTorrents() {
      return structuredClone(torrents)
    },
    async torrentFiles() {
      return [
        { index: 0, name: 'Dune.Part.Two.2160p.mkv', path: 'Dune/Dune.Part.Two.2160p.mkv', length: 17.6e9, downloaded: 7.4e9, progress: 0.42, selected: true, playable: true },
        { index: 1, name: 'Dune.Part.Two.rus.srt', path: 'Dune/Subs/Dune.Part.Two.rus.srt', length: 9e4, downloaded: 9e4, progress: 1, selected: true, playable: false },
        { index: 2, name: 'Sample.mkv', path: 'Dune/Sample.mkv', length: 4e8, downloaded: 0, progress: 0, selected: false, playable: true },
      ]
    },
    async setFileSelection() {},
    async streamUrl() {
      return 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'
    },
    async getMagnetHandler() {
      return false
    },
    async setMagnetHandler(on: boolean) {
      return on
    },
    async updateStatus() {
      return { state: 'idle', version: '0.2.0' }
    },
    async checkForUpdates() {
      return { state: 'unsupported', version: '0.2.0' }
    },
    async installUpdate() {},
    onUpdateStatus() {
      return () => {}
    },
    onNavigate() {
      return () => {}
    },
    onTorrents(cb: (t: TorrentInfo[]) => void) {
      torrentListeners.add(cb)
      return () => torrentListeners.delete(cb)
    },
    async pauseTorrent(h: string) {
      torrents.find((t) => t.infoHash === h)!.state = 'paused'
    },
    async resumeTorrent(h: string) {
      torrents.find((t) => t.infoHash === h)!.state = 'downloading'
    },
    async removeTorrent(h: string) {
      torrents.splice(torrents.findIndex((t) => t.infoHash === h), 1)
    },
    async openTorrentFolder() {},
    async openTorrentFile() {},
    async getSettings() {
      return settings
    },
    async updateSettings(patch: Partial<AppSettings>) {
      settings = { ...settings, ...patch }
      return settings
    },
    async chooseDownloadDir() {
      return null
    },
    async openExternal(url: string) {
      window.open(url, '_blank')
    },
  }
  return mock as unknown as Api
}
