import { describe, expect, it } from 'vitest'
import { audioOf, hasAudio } from '../src/core/audio'

const en = (title: string, anime = false) => audioOf(title, anime).english

describe('audio languages from titles', () => {
  it('treats untagged scene releases as likely English', () => {
    expect(en('Dune.Part.Two.2024.1080p.BluRay.x264-SPARKS')).toBe('likely')
    expect(en('Dune (2021) [1080p] [BluRay] [YTS.MX]')).toBe('likely')
  })

  it('reads explicit tags', () => {
    expect(en('Spirited Away (2001) [1080p] [Dual Audio]')).toBe('yes')
    expect(en('Dune Part Two 2024 MULTi 2160p WEB')).toBe('yes')
    expect(en('Dune Prophecy S01E01 2024 VOSTFR HDTV')).toBe('yes')
    expect(en('Дюна / Dune (2021) BDRip 1080p | D, A, Original Eng')).toBe('yes')
    expect(en('Дюна (2021) BDRip 1080p | Дубляж, Оригинал')).toBe('yes')
    expect(en('Movie.2020.1080p.WEB-DL.Rus.Eng')).toBe('yes')
  })

  it('rejects releases voiced in other languages only', () => {
    expect(en('Дюна: Часть вторая / Dune: Part Two (2024) WEB-DL 1080p | Дубляж')).toBe('no')
    expect(en('Дюна (2021) WEB-DL 1080p | Лицензия')).toBe('no')
    expect(en('Dune Prophecy S01E05 2024 FRENCH HDTV')).toBe('no')
    expect(en('Dune 2021 1080p WEB-DL Rus Sub Eng')).toBe('no')
    expect(en('Pushpa 2 (2024) Hindi 1080p WEB-DL')).toBe('no')
    expect(en('[SubsPlease] Frieren - 12 (1080p)', true)).toBe('no')
  })

  it('knows Russian and Ukrainian voice-overs', () => {
    expect(hasAudio(audioOf('Дюна (2021) WEB-DL 1080p | Лицензия'), 'ru')).toBe(true)
    expect(hasAudio(audioOf('Дюна (2021) BDRip | MVO, Ukr, Eng'), 'uk')).toBe(true)
    expect(hasAudio(audioOf('Dune.2021.1080p.BluRay.x264'), 'ru')).toBe(false)
    expect(audioOf('Dune 2021 1080p WEB-DL Rus Sub Eng').langs).toEqual(['ru'])
  })
})

describe('relevance', () => {
  it('ranks phrase > all words > loose, over the query and its translations', async () => {
    const { relevance } = await import('../src/core/filters')
    const terms = ['дюна', 'Dune']
    expect(relevance('Dune.Part.Two.2024.1080p', terms)).toBe(2)
    expect(relevance('Дюна: Часть вторая (2024)', terms)).toBe(2)
    expect(relevance('Casshern Sins (2008) 1080p', terms)).toBe(0)
    expect(relevance('Frank Herbert - Dune Messiah', ['dune messiah'])).toBe(2)
    expect(relevance('Messiah of Dune', ['dune messiah'])).toBe(1)
    expect(relevance('Ёлки 2 (2011)', ['елки'])).toBe(2)
  })
})

describe('subtitles from titles', () => {
  const subs = (title: string) => audioOf(title).subs.sort()
  it('reads subtitle tags', () => {
    expect(subs('Dune.2021.1080p.WEB-DL.Rus.Sub.Eng')).toEqual(['en'])
    expect(subs('Dune Prophecy Season 1 COMPLETE 1080p MAX WEB DL x264 ESubs 5 4G')).toEqual(['en'])
    expect(subs('Movie (2020) BDRip 1080p | Sub: Rus, Eng')).toEqual(['en', 'ru'])
    expect(subs('Дюна (2021) BDRip | Дубляж | Субтитры: русские, английские')).toEqual(['en', 'ru'])
    expect(subs('[Erai-raws] Frieren - 12 [1080p][Multiple Subtitle]')).toEqual(['multi'])
    expect(subs('The.Movie.2019.2160p.WEB-DL.DDP5.1.SDH')).toEqual(['en'])
    expect(subs('Dune.Part.Two.2024.1080p.BluRay.x264-SPARKS')).toEqual([])
    expect(audioOf('[SubsPlease] Frieren - 12 (1080p)').hasSubs).toBe(false)
  })
  it('does not take subtitle languages for audio', () => {
    expect(audioOf('Movie (2020) BDRip 1080p | Sub: Rus, Eng').langs).toEqual([])
  })
})
