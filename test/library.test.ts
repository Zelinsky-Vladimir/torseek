import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { matchesFilters, titleMatchesQuery } from '../src/core/filters'
import type { Release } from '../src/core/release'
import { Library } from '../src/main/library'

const rel = (title: string, hash: string, extra: Partial<Release> = {}): Release => ({
  indexerId: 'x',
  indexerName: 'X',
  title,
  guid: hash,
  infoHash: hash,
  categories: [5040],
  seeders: 10,
  ...extra,
})

let lib: Library | undefined
afterEach(() => {
  lib?.close()
  lib = undefined
})
const open = () => (lib = new Library(join(mkdtempSync(join(tmpdir(), 'lib-')), 'library.db')))
const db = () => lib!

describe('Library', () => {
  it('keeps search history unique and most-recent first', () => {
    open()
    db().addHistory('dune', 10)
    db().addHistory('the boys', 5)
    db().addHistory('DUNE', 12)
    expect(db().history().map((h) => [h.query, h.results])).toEqual([
      ['dune', 12],
      ['the boys', 5],
    ])
    db().clearHistory()
    expect(db().history()).toEqual([])
  })

  it('stores favorites by release identity', () => {
    open()
    const r = rel('Dune 2021 1080p', 'aa')
    db().addFavorite(r)
    db().addFavorite({ ...r, indexerId: 'other' }) // same torrent from another tracker
    expect(db().favorites()).toHaveLength(1)
    db().removeFavorite(db().favoriteKeys()[0])
    expect(db().favorites()).toEqual([])
  })

  it('treats the first check as baseline and reports only later releases', () => {
    open()
    const id = db().addWatch('the boys', { resolutions: ['1080p'] })
    expect(db().recordCheck(id, [rel('The Boys S05E01 1080p', 'e1'), rel('The Boys S05E02 1080p', 'e2')])).toEqual([])
    expect(db().watch(id)?.newCount).toBe(0)

    const fresh = db().recordCheck(id, [rel('The Boys S05E02 1080p', 'e2'), rel('The Boys S05E03 1080p', 'e3')])
    expect(fresh.map((r) => r.infoHash)).toEqual(['e3'])
    expect(db().watch(id)?.newCount).toBe(1)
    expect(db().hits(id).map((h) => h.release.infoHash)).toEqual(['e3'])

    db().markSeen(id)
    expect(db().watch(id)?.newCount).toBe(0)
    db().removeWatch(id)
    expect(db().watches()).toEqual([])
  })
})

describe('watch filters', () => {
  it('requires every query word in the title', () => {
    expect(titleMatchesQuery('The.Boys.S05E03.1080p.WEB', 'the boys')).toBe(true)
    expect(titleMatchesQuery('Boyz n the Hood 1991', 'the boys')).toBe(false)
    expect(titleMatchesQuery('Пацаны / The Boys S05', 'пацаны')).toBe(true)
  })
  it('applies chips, resolution, seeds and the adult switch', () => {
    const r = rel('The Boys S05E03 1080p', 'e3', { seeders: 3 })
    expect(matchesFilters(r, { chips: ['tv'], resolutions: ['1080p'] })).toBe(true)
    expect(matchesFilters(r, { chips: ['movies'] })).toBe(false)
    expect(matchesFilters(r, { resolutions: ['2160p'] })).toBe(false)
    expect(matchesFilters(r, { minSeeds: 5 })).toBe(false)
    expect(matchesFilters({ ...r, categories: [6000] }, {})).toBe(false)
    expect(matchesFilters({ ...r, categories: [6000] }, { showAdult: true })).toBe(true)
  })
})
