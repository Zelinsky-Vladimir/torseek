import { matchesFilters, titleMatchesQuery } from '../core/filters'
import type { Release } from '../core/release'
import type { Watch } from '../shared/api'
import type { IndexerManager } from './indexers'
import type { Library } from './library'

// Re-runs watched searches in the background and reports releases that weren't there
// before (e.g. a new episode). Same filters as the search screen, plus a check that
// every query word is in the title, because trackers return loose matches.

export interface WatcherOptions {
  intervalMs: () => number
  showAdult: () => boolean
  concurrency: () => number
  timeoutMs: () => number
  onNew: (watch: Watch, fresh: Release[]) => void
  onChecked: () => void
}

export class Watcher {
  private timer?: NodeJS.Timeout
  private running = new Set<number>()

  constructor(
    private readonly library: Library,
    private readonly indexers: IndexerManager,
    private readonly opts: WatcherOptions,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  start() {
    // Look for due watches every 10 minutes; each watch has its own interval
    this.timer = setInterval(() => void this.checkDue(), 10 * 60_000)
    setTimeout(() => void this.checkDue(), 60_000)
  }

  stop() {
    clearInterval(this.timer)
  }

  async checkDue() {
    for (const w of this.library.dueWatches(this.opts.intervalMs())) await this.check(w.id)
  }

  async check(id: number): Promise<Watch | undefined> {
    const watch = this.library.watch(id)
    if (!watch || this.running.has(id)) return watch
    this.running.add(id)
    try {
      const found: Release[] = []
      await this.indexers.search(
        { q: watch.query },
        {
          concurrency: this.opts.concurrency(),
          timeoutMs: this.opts.timeoutMs(),
          onResults: (_, releases) => found.push(...releases),
          onStatus: () => {},
        },
      )
      const filters = { ...watch.filters, showAdult: this.opts.showAdult() }
      const relevant = found.filter((r) => titleMatchesQuery(r.title, watch.query) && matchesFilters(r, filters))
      const fresh = this.library.recordCheck(id, relevant)
      this.log(`watch "${watch.query}": ${relevant.length} matching, ${fresh.length} new`)
      if (fresh.length) this.opts.onNew(this.library.watch(id)!, fresh)
      this.opts.onChecked()
      return this.library.watch(id)
    } finally {
      this.running.delete(id)
    }
  }
}
