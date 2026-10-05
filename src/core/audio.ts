// Which audio languages a release has, read from its title. Trackers name them in many
// ways: "Dual Audio", "MULTi", "Rus, Eng", "Дубляж + Оригинал", "TRUEFRENCH", "VOSTFR"
// (original audio, French subtitles). Scene releases without any language tag are in
// English by convention, so an untagged Latin-only title counts as likely English
// (anime aside: there it means Japanese).

export type AudioLang = 'en' | 'ru' | 'uk' | 'fr' | 'de' | 'es' | 'it' | 'other'

export interface AudioInfo {
  /** Languages named in the title ("multi" adds nothing here, see `multi`) */
  langs: AudioLang[]
  multi: boolean
  /** yes: tagged; likely: untagged scene-style title; no: only other languages */
  english: 'yes' | 'likely' | 'no'
}

// "Sub Eng", "Subs: Rus, Eng", "Субтитры: английские" describe subtitles, not audio
const SUBTITLES = /\b(?:sub(?:s|titles?)?|softsub|hardsub)\b[\s.:_-]*(?:[a-z]{2,3}(?:[\s,+/&]+[a-z]{2,3}){0,4})\b|субтитр\p{L}*[^|\])]*|сабы[^|\])]*/giu

const PATTERNS: [AudioLang, RegExp][] = [
  ['en', /\b(?:eng|english)\b|\boriginal\b|оригинал|(?<!\p{L})ориг(?!\p{L})|\bvo(?:st(?:fr)?)?\b|\b\d?xeng\b/iu],
  ['ru', /дубляж|дублир|\bdub(?:bed)?\b|\b[mdal]vo\b|многоголос|двухголос|одноголос|профессиональн|любительск|авторск|\brus\b|russian|(?<!\p{L})рус(?!\p{L})|lostfilm|newstudio|кубик в кубе|hdrezka|coldfilm|jaskier|гоблин/iu],
  ['uk', /\bukr\b|ukrainian|(?<!\p{L})укр(?!\p{L})|українськ/iu],
  ['fr', /truefrench|\bfrench\b|\bvf[f2q]?\b|\bfr\b/iu],
  ['de', /\bgerman\b|\bdeutsch\b|\bger\b/iu],
  ['es', /\bspanish\b|\blatino\b|\bcastellano\b|\besp\b|\bspa\b/iu],
  ['it', /\bita(?:lian)?\b/iu],
  ['other', /\bhindi\b|\btamil\b|\btelugu\b|\bkorean\b|\bjapanese\b|\bchinese\b|\bmandarin\b|\bcantonese\b|\bturkish\b|\bpolish\b|\bpl\b|\bdublado\b|\bdual\s+lat\b/iu],
]

const NON_LATIN = /[\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Greek}\p{Script=Thai}]/u

/** anime: untagged anime releases carry Japanese audio, not English */
export function audioOf(title: string, anime = false): AudioInfo {
  // Separators that \b wouldn't see: "Rus.Eng", "Dual-Audio", "[ENG]"
  const t = title.replace(/[._[\](){}]/g, ' ').replace(SUBTITLES, ' ')
  const langs = PATTERNS.filter(([, re]) => re.test(t)).map(([l]) => l)
  const multi = /\bmulti\b|\bdual[\s-]*audio\b|мульти/iu.test(t)
  const english = langs.includes('en') || multi ? 'yes' : langs.length || anime || NON_LATIN.test(t) ? 'no' : 'likely'
  // A Cyrillic title on a Russian/Ukrainian tracker is voiced in Russian unless it says otherwise
  if (!langs.includes('ru') && !langs.includes('uk') && /\p{Script=Cyrillic}/u.test(title) && !/субтитр/iu.test(title)) langs.push('ru')
  return { langs, multi, english }
}

/** Filter test for "audio language" */
export function hasAudio(info: AudioInfo, lang: 'en' | 'ru' | 'uk'): boolean {
  if (lang === 'en') return info.english !== 'no'
  return info.langs.includes(lang)
}
