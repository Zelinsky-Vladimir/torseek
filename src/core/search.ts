import type { Indexer, SearchQuery } from './indexer'
import type { Release } from './release'

// Fans a query out to many trackers and streams results back as each one answers,
// instead of waiting for the slowest (Jackett waits up to 40s for all of them).

export type IndexerState = 'queued' | 'running' | 'done' | 'error' | 'blocked' | 'timeout' | 'cancelled'

export interface IndexerStatus {
  indexerId: string
  indexerName: string
  state: IndexerState
  count?: number
  error?: string
  elapsedMs?: number
}

export interface SearchAllOptions {
  concurrency?: number
  timeoutMs?: number
  signal?: AbortSignal
  onResults: (indexerId: string, releases: Release[]) => void
  onStatus: (status: IndexerStatus) => void
  /**
   * More keywords for one tracker (say, the title in the tracker's language), searched
   * after the main query succeeds. Results already found are not reported twice.
   */
  extraQueries?: (ix: Indexer) => Promise<string[]>
}

export async function searchAll(indexers: Indexer[], query: SearchQuery, opts: SearchAllOptions): Promise<void> {
  const { concurrency = 12, timeoutMs = 25_000, signal } = opts
  for (const ix of indexers) opts.onStatus({ indexerId: ix.id, indexerName: ix.name, state: 'queued' })

  const queue = [...indexers]
  const worker = async () => {
    for (let ix = queue.shift(); ix; ix = queue.shift()) {
      const base = { indexerId: ix.id, indexerName: ix.name }
      if (signal?.aborted) {
        opts.onStatus({ ...base, state: 'cancelled' })
        continue
      }
      const started = Date.now()
      opts.onStatus({ ...base, state: 'running' })
      const seen = new Set<string>()
      const run = async (q: SearchQuery) => {
        const timeout = AbortSignal.timeout(timeoutMs)
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
        try {
          const releases = (await raceAbort(ix.search(q, combined), combined)).filter((r) => {
            const key = r.guid || r.link || r.magnet || r.title
            return !seen.has(key) && !!seen.add(key)
          })
          opts.onResults(ix.id, releases)
          return releases.length
        } catch (e) {
          throw Object.assign(e instanceof Error ? e : new Error(String(e)), { timedOut: timeout.aborted })
        }
      }
      try {
        let count = await run(query)
        const extra = opts.extraQueries && !signal?.aborted ? await opts.extraQueries(ix).catch(() => []) : []
        for (const q of extra) {
          if (signal?.aborted) break
          // The main query already worked; a failing extra one doesn't make the tracker red
          count += await run({ ...query, q }).catch(() => 0)
        }
        opts.onStatus({ ...base, state: 'done', count, elapsedMs: Date.now() - started })
      } catch (e) {
        const timedOut = (e as { timedOut?: boolean }).timedOut
        const state: IndexerState = signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : (e as Error)?.name === 'CloudflareError' ? 'blocked' : 'error'
        opts.onStatus({ ...base, state, error: state === 'error' ? describeError(e) : undefined, elapsedMs: Date.now() - started })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, indexers.length) }, worker))
}

// requestDelay sleeps don't observe the signal, so make sure we stop waiting regardless
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function describeError(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } }
  const cause = err?.cause?.code ?? err?.cause?.message
  return cause ? `${err.message} (${cause})` : (err?.message ?? String(e))
}
