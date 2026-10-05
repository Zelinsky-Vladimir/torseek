// UI-side i18n: holds the current language and exposes t / tn / translateError.
// Dictionaries and plural rules live in src/shared/i18n (also used by the main process).

import { resolveLanguage, translator, type Key, type Lang, type LangSetting, type Params } from '../../shared/i18n'

export { LANGUAGES } from '../../shared/i18n'
export type { Key, Lang, LangSetting }

let current: Lang = 'en'
let tr = translator(current)

const systemLocales = () => (typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [])

export const resolveLang = (setting: LangSetting | undefined): Lang => resolveLanguage(setting, systemLocales())

export function setLang(lang: Lang) {
  current = lang
  tr = translator(lang)
  if (typeof document !== 'undefined') document.documentElement.lang = lang
}

export const getLang = () => current
export const t = (key: Key, params?: Params) => tr.t(key, params)
export const tn = (key: Key, n: number, params?: Params) => tr.tn(key, n, params)
export const translateError = (message: string) => tr.error(message)
