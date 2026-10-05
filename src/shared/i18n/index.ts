// Translation core shared by the UI and the main process (window titles).
// Each locale is a flat dictionary; TypeScript enforces that every key exists.
// Plural forms are '|'-separated, in the order given by PLURAL_ORDER for the language.

import { de } from './de'
import { en, type Dict, type Key } from './en'
import { es } from './es'
import { fr } from './fr'
import { it } from './it'
import { ja } from './ja'
import { ko } from './ko'
import { pl } from './pl'
import { pt } from './pt'
import { ru } from './ru'
import { tr } from './tr'
import { uk } from './uk'
import { zh } from './zh'

export type { Key, Dict }

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Русский' },
  { code: 'uk', name: 'Українська' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'it', name: 'Italiano' },
  { code: 'pl', name: 'Polski' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'zh', name: '简体中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
] as const

export type Lang = (typeof LANGUAGES)[number]['code']
export type LangSetting = Lang | 'auto'

export const DICTIONARIES: Record<Lang, Dict> = { en, ru, uk, es, pt, fr, de, it, pl, tr, zh, ja, ko }

const PLURAL_ORDER: Record<Lang, Intl.LDMLPluralRule[]> = {
  en: ['one', 'other'],
  es: ['one', 'other'],
  pt: ['one', 'other'],
  fr: ['one', 'other'],
  de: ['one', 'other'],
  it: ['one', 'other'],
  ru: ['one', 'few', 'many'],
  uk: ['one', 'few', 'many'],
  pl: ['one', 'few', 'many'],
  tr: ['other'],
  zh: ['other'],
  ja: ['other'],
  ko: ['other'],
}

const isLang = (code: string): code is Lang => code in DICTIONARIES

/** Best supported language for a list of BCP-47 locales, e.g. ['pt-BR', 'en-US']. */
export function matchLanguage(locales: readonly string[]): Lang {
  for (const locale of locales) {
    const base = locale.toLowerCase().split(/[-_]/)[0]
    if (isLang(base)) return base
    if (base === 'be' || base === 'kk') return 'ru'
  }
  return 'en'
}

export function resolveLanguage(setting: LangSetting | undefined, systemLocales: readonly string[]): Lang {
  return setting && setting !== 'auto' && isLang(setting) ? setting : matchLanguage(systemLocales)
}

export type Params = Record<string, string | number>

const interpolate = (s: string, params?: Params) => (params ? s.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`)) : s)

export function translator(lang: Lang) {
  const dict = DICTIONARIES[lang]
  const raw = (key: Key) => dict[key] ?? en[key] ?? key
  const rules = new Intl.PluralRules(lang)

  const t = (key: Key, params?: Params) => interpolate(raw(key).split('|')[0], params)

  const tn = (key: Key, n: number, params?: Params) => {
    const forms = raw(key).split('|')
    const order = PLURAL_ORDER[lang]
    const index = order.indexOf(rules.select(n))
    return interpolate(forms[Math.min(index < 0 ? forms.length - 1 : index, forms.length - 1)], { n, ...params })
  }

  /** Engine errors are English; map the ones users actually see onto dictionary keys. */
  const error = (message: string): string => {
    const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
      [/^Blocked by Cloudflare\/DDoS protection$/, () => t('err.cloudflare')],
      [/^The site still shows its protection page$/, () => t('err.stillProtected')],
      [/^Download did not return a torrent file/, () => t('err.noTorrent')],
      [/^This tracker only provides \.torrent files$/, () => t('err.torrentOnly')],
      [/^Unsupported magnet link$/, () => t('err.badMagnet')],
      [/^fetch failed/, () => t('err.connect')],
      [/aborted due to timeout/i, () => t('err.timeout')],
    ]
    for (const [re, fn] of patterns) {
      const m = message.match(re)
      if (m) return fn(m)
    }
    return message
  }

  return { t, tn, error }
}
