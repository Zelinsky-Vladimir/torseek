import { describe, expect, it } from 'vitest'
import { findTitleNames, nameFor, splitQuery, variantFor } from '../src/main/title-names'
import { searchAll } from '../src/core/search'
import type { Indexer } from '../src/core/indexer'
import type { Release } from '../src/core/release'

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

function wikidata(entities: Record<string, unknown>, hits: string[]) {
  const calls: string[] = []
  const impl = (async (url: URL) => {
    calls.push(url.searchParams.get('action')!)
    return url.searchParams.get('action') === 'query' ? json({ query: { search: hits.map((title) => ({ title })) } }) : json({ entities })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const DUNE = {
  Q1: { labels: { en: { value: 'Dune Prophecy' }, ru: { value: 'Дюна: Пророчество' } } },
  Q2: { labels: { en: { value: 'Dune' }, ru: { value: 'Дюна' }, 'zh-hans': { value: '沙丘' } }, aliases: { en: [{ value: 'Dune: Part One' }] } },
}

describe('title names', () => {
  it('keeps year / quality words out of the title', () => {
    expect(splitQuery('дюна 2021 2160p')).toEqual({ title: 'дюна', suffix: '2021 2160p' })
    expect(splitQuery('the office s02e03')).toEqual({ title: 'the office', suffix: 's02e03' })
    expect(splitQuery('1917')).toEqual({ title: '1917', suffix: '' })
  })

  it('uses the first hit that is actually named like the query', async () => {
    const { impl } = wikidata(DUNE, ['Q1', 'Q2'])
    const n = await findTitleNames('Дюна 2160p', impl)
    expect(n?.names.en).toBe('Dune')
    expect(variantFor(n!, 'en-US', 'Дюна 2160p')).toBe('Dune 2160p')
    expect(variantFor(n!, 'ru-RU', 'Дюна 2160p')).toBeUndefined()
    expect(variantFor(n!, 'zh-CN', 'Дюна 2160p')).toBe('沙丘 2160p')
    // no Korean label: English
    expect(nameFor(n!.names, 'ko-KR')).toBe('Dune')
  })

  it('matches aliases, cleans punctuation and caches', async () => {
    const { impl, calls } = wikidata(DUNE, ['Q2'])
    const n = await findTitleNames('dune part one', impl)
    expect(variantFor(n!, 'ru', 'dune part one')).toBe('Дюна')
    await findTitleNames('Dune Part One', impl)
    expect(calls).toEqual(['query', 'wbgetentities'])
  })

  it('ignores loose matches', async () => {
    const { impl } = wikidata(DUNE, ['Q1', 'Q2'])
    expect(await findTitleNames('dune sea documentary', impl)).toBeNull()
  })
})

describe('searchAll extra queries', () => {
  const release = (title: string): Release => ({ indexerId: 'x', indexerName: 'X', title, guid: title, link: '', size: 1, seeders: 1, leechers: 0, publishDate: '', categories: [] }) as Release
  const ix = (byQuery: Record<string, string[]>): Indexer =>
    ({ id: 'x', name: 'X', search: async (q: { q: string }) => (byQuery[q.q] ?? []).map(release) }) as unknown as Indexer

  it('runs them after the main query and drops duplicates', async () => {
    const got: string[] = []
    const statuses: { state: string; count?: number }[] = []
    await searchAll([ix({ dune: ['a', 'b'], Дюна: ['b', 'c'] })], { q: 'dune' }, {
      onResults: (_, rs) => got.push(...rs.map((r) => r.title)),
      onStatus: (s) => statuses.push(s),
      extraQueries: async () => ['Дюна'],
    })
    expect(got).toEqual(['a', 'b', 'c'])
    expect(statuses.at(-1)).toMatchObject({ state: 'done', count: 3 })
  })

  it('skips them when the main query failed', async () => {
    let extra = 0
    const failing = { id: 'x', name: 'X', search: async () => Promise.reject(new Error('boom')) } as unknown as Indexer
    const statuses: { state: string }[] = []
    await searchAll([failing], { q: 'dune' }, { onResults: () => {}, onStatus: (s) => statuses.push(s), extraQueries: async () => (extra++, ['x']) })
    expect(extra).toBe(0)
    expect(statuses.at(-1)?.state).toBe('error')
  })
})
