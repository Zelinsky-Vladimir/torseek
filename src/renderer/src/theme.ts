import { resolveTheme, themeVars, THEMES, type AccentId, type ThemeSetting } from '../../shared/themes'

// Writes the theme into the Tailwind color variables on <html>. The last applied set is
// cached so the next launch paints in the right colors before settings arrive.

const CACHE = 'torseek.theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')
let current: { theme?: ThemeSetting; accent?: AccentId } = {}

function paint(vars: Record<string, string>, scheme: string) {
  const root = document.documentElement
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.style.colorScheme = scheme
}

export function applyTheme(theme: ThemeSetting | undefined, accent: AccentId | undefined) {
  current = { theme, accent }
  const id = resolveTheme(theme, media.matches)
  const vars = themeVars(id, accent)
  paint(vars, THEMES[id].scheme)
  try {
    localStorage.setItem(CACHE, JSON.stringify({ vars, scheme: THEMES[id].scheme }))
  } catch {
    /* storage unavailable */
  }
}

// "System" follows the OS switching between light and dark
media.addEventListener('change', () => current.theme === 'system' && applyTheme(current.theme, current.accent))

try {
  const cached = JSON.parse(localStorage.getItem(CACHE) ?? 'null') as { vars: Record<string, string>; scheme: string } | null
  if (cached?.vars) paint(cached.vars, cached.scheme)
} catch {
  /* no cache */
}
