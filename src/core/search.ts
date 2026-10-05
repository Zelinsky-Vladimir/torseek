import type { Indexer, SearchQuery } from './indexer'
import type { Release } from './release'

// Fans a query out to many trackers and streams results back as each one answers,
// instead of waiting for the slowest (Jackett waits up to 40s for all of them).

export type IndexerState = 'queued' | 'running' | 'done' | 'error' | 'blocked' | 'auth' | 'timeout' | 'cancelled'

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
      const timeout = AbortSignal.timeout(timeoutMs)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      try {
        const releases = await raceAbort(ix.search(query, combined), combined)
        opts.onResults(ix.id, releases)
        opts.onStatus({ ...base, state: 'done', count: releases.length, elapsedMs: Date.now() - started })
      } catch (e) {
        const state: IndexerState = signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : (e as Error)?.name === 'CloudflareError' ? 'blocked' : (e as Error)?.name === 'LoginRequiredError' ? 'auth' : 'error'
        opts.onStatus({ ...base, state, error: state === 'error' || state === 'auth' ? describeError(e) : undefined, elapsedMs: Date.now() - started })
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
