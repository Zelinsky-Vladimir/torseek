// Color themes. The renderer writes these into the Tailwind color variables; the main
// process uses bg / muted for the window background and the title bar buttons.

export const THEME_IDS = ['dark', 'light', 'black', 'nord', 'mocha', 'sepia'] as const
export type ThemeId = (typeof THEME_IDS)[number]
export type ThemeSetting = 'system' | ThemeId

export const ACCENT_IDS = ['violet', 'blue', 'teal', 'green', 'orange', 'pink', 'red'] as const
export type AccentId = (typeof ACCENT_IDS)[number]

export interface Palette {
  scheme: 'dark' | 'light'
  bg: string
  panel: string
  'panel-2': string
  hover: string
  line: string
  'line-2': string
  fg: string
  muted: string
  faint: string
  good: string
  warn: string
  bad: string
}

const STATUS_DARK = { good: '#3ccf8e', warn: '#e8b34b', bad: '#f2667a' }
const STATUS_LIGHT = { good: '#12a26b', warn: '#b7791f', bad: '#d9415b' }

export const THEMES: Record<ThemeId, Palette> = {
  dark: {
    scheme: 'dark',
    bg: '#0b0d12',
    panel: '#12151c',
    'panel-2': '#181c25',
    hover: '#1d2230',
    line: '#242a38',
    'line-2': '#303849',
    fg: '#e7e9ef',
    muted: '#8b93a7',
    faint: '#5d6579',
    ...STATUS_DARK,
  },
  light: {
    scheme: 'light',
    bg: '#f5f6f8',
    panel: '#ffffff',
    'panel-2': '#eef0f4',
    hover: '#e7eaf0',
    line: '#dde1e8',
    'line-2': '#c9cfd9',
    fg: '#161a22',
    muted: '#596173',
    faint: '#8a91a1',
    ...STATUS_LIGHT,
  },
  black: {
    scheme: 'dark',
    bg: '#000000',
    panel: '#0b0b0d',
    'panel-2': '#121215',
    hover: '#18181c',
    line: '#202025',
    'line-2': '#2c2c33',
    fg: '#ececf1',
    muted: '#8d8d99',
    faint: '#5c5c66',
    ...STATUS_DARK,
  },
  nord: {
    scheme: 'dark',
    bg: '#242933',
    panel: '#2b303b',
    'panel-2': '#323845',
    hover: '#3b4252',
    line: '#3b4252',
    'line-2': '#4c566a',
    fg: '#eceff4',
    muted: '#a3acbd',
    faint: '#6f7889',
    good: '#a3be8c',
    warn: '#ebcb8b',
    bad: '#d08770',
  },
  mocha: {
    scheme: 'dark',
    bg: '#11111b',
    panel: '#181825',
    'panel-2': '#1e1e2e',
    hover: '#262637',
    line: '#313244',
    'line-2': '#45475a',
    fg: '#cdd6f4',
    muted: '#a6adc8',
    faint: '#6c7086',
    good: '#a6e3a1',
    warn: '#f9e2af',
    bad: '#f38ba8',
  },
  sepia: {
    scheme: 'light',
    bg: '#f3ead6',
    panel: '#fbf6ea',
    'panel-2': '#eee3ca',
    hover: '#e7dabd',
    line: '#ddcfb0',
    'line-2': '#cbb994',
    fg: '#3b3125',
    muted: '#6c5e4a',
    faint: '#9a8b73',
    good: '#4f8a3c',
    warn: '#a0640f',
    bad: '#b4473a',
  },
}

// [accent, accent-2] for dark and for light backgrounds (deeper, so text stays readable)
export const ACCENTS: Record<AccentId, { dark: [string, string]; light: [string, string] }> = {
  violet: { dark: ['#8b7bff', '#6d5cf0'], light: ['#6d5cf0', '#5a48e0'] },
  blue: { dark: ['#5b9dff', '#3b7fe8'], light: ['#2f6fdb', '#245bc0'] },
  teal: { dark: ['#3cc8c0', '#22a8a0'], light: ['#0f8f88', '#0b7570'] },
  green: { dark: ['#4fcf7a', '#33b060'], light: ['#1f9a4c', '#17803e'] },
  orange: { dark: ['#ff9a4d', '#f07a2a'], light: ['#d9661a', '#b85412'] },
  pink: { dark: ['#ff6fb1', '#ec4f97'], light: ['#d63f86', '#b8306f'] },
  red: { dark: ['#ff6b6b', '#e84c4c'], light: ['#d43c3c', '#b52f2f'] },
}

export const resolveTheme = (setting: ThemeSetting | undefined, systemDark: boolean): ThemeId =>
  !setting || setting === 'system' || !THEMES[setting] ? (systemDark ? 'dark' : 'light') : setting

/** CSS variable name -> value for a theme + accent */
export function themeVars(theme: ThemeId, accent: AccentId | undefined): Record<string, string> {
  const { scheme, ...colors } = THEMES[theme]
  const [a1, a2] = (ACCENTS[accent ?? 'violet'] ?? ACCENTS.violet)[scheme]
  return Object.fromEntries([...Object.entries(colors), ['accent', a1], ['accent-2', a2]].map(([k, v]) => [`--color-${k}`, v]))
}
