import { afterEach, describe, expect, it } from 'vitest'
import { DICTIONARIES, LANGUAGES, matchLanguage, translator, type Key } from '../src/shared/i18n'
import { en } from '../src/shared/i18n/en'
import { setLang, t, tn, translateError } from '../src/renderer/src/i18n'

const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()
const PLURAL_KEYS = Object.keys(en).filter((k) => en[k as Key].includes('|')) as Key[]
const FORMS: Record<string, number> = { en: 2, es: 2, pt: 2, fr: 2, de: 2, it: 2, ru: 3, uk: 3, pl: 3, tr: 1, zh: 1, ja: 1, ko: 1 }

describe('dictionaries', () => {
  it('registers every language', () => {
    expect(LANGUAGES.map((l) => l.code).sort()).toEqual(Object.keys(DICTIONARIES).sort())
  })

  for (const [lang, dict] of Object.entries(DICTIONARIES)) {
    it(`${lang}: same placeholders as English, no empty strings`, () => {
      for (const key of Object.keys(en) as Key[]) {
        expect(dict[key], `${lang} ${key}`).toBeTruthy()
        for (const form of dict[key].split('|')) expect(placeholders(form), `${lang} ${key}: "${form}"`).toEqual(placeholders(en[key].split('|')[0]))
      }
    })

    it(`${lang}: plural keys have the right number of forms`, () => {
      for (const key of PLURAL_KEYS) {
        const n = dict[key].split('|').length
        // single-form text is fine where the language needs no agreement
        expect(n === FORMS[lang] || n === 1, `${lang} ${key} has ${n} forms`).toBe(true)
      }
    })
  }
})

describe('plurals', () => {
  it('Russian', () => {
    const { tn } = translator('ru')
    expect([1, 3, 5, 11, 21, 22, 25].map((n) => tn('search.results', n))).toEqual([
      '1 результат', '3 результата', '5 результатов', '11 результатов', '21 результат', '22 результата', '25 результатов',
    ])
  })
  it('Ukrainian and Polish', () => {
    expect([1, 2, 5].map((n) => translator('uk').tn('search.results', n))).toEqual(['1 результат', '2 результати', '5 результатів'])
    expect([1, 2, 5, 22].map((n) => translator('pl').tn('search.results', n))).toEqual(['1 wynik', '2 wyniki', '5 wyników', '22 wyniki'])
  })
  it('languages without plural agreement', () => {
    expect(translator('ja').tn('search.results', 3)).toBe('3 件')
    expect(translator('zh').tn('search.results', 1)).toBe('1 个结果')
  })
})

describe('language detection', () => {
  it('matches the first supported system locale', () => {
    expect(matchLanguage(['pt-BR', 'en-US'])).toBe('pt')
    expect(matchLanguage(['zh-Hans-CN'])).toBe('zh')
    expect(matchLanguage(['be-BY'])).toBe('ru')
    expect(matchLanguage(['nl-NL', 'de-DE'])).toBe('de')
    expect(matchLanguage(['nl-NL'])).toBe('en')
  })
})

describe('renderer wrapper', () => {
  afterEach(() => setLang('en'))

  it('switches language at runtime', () => {
    expect(t('search.placeholder', { n: 32 })).toBe('Search 32 trackers…')
    expect(tn('search.results', 2)).toBe('2 results')
    setLang('de')
    expect(t('search.placeholder', { n: 32 })).toBe('32 Tracker durchsuchen…')
  })

  it('translates known engine errors and leaves unknown ones alone', () => {
    setLang('ru')
    expect(translateError('Fill in Username, Password or sign in through the browser')).toBe('Заполните: Логин, Пароль — или войдите через браузер')
    setLang('fr')
    expect(translateError('Blocked by Cloudflare/DDoS protection')).toBe('Bloqué par la protection Cloudflare / DDoS-Guard')
    expect(translateError('something unexpected')).toBe('something unexpected')
  })
})
