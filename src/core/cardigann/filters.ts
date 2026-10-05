import { decodeHTML, encodeHTML } from 'entities'
import { parseDateLayout, fromTimeAgo, fromUnknown } from './dates'
import { dotnetRegex, dotnetReplace } from './dotnet-regex'
import { urlDecode, urlEncode } from './encoding'
import { queryStringArg } from './parse'
import { applyTemplate, type Vars } from './template'
import type { FilterArgs, FilterBlock } from './types'

export interface FilterContext {
  vars: Vars
  encoding?: string
  log?: (msg: string) => void
}

const arg = (args: FilterArgs, i = 0): string => {
  if (Array.isArray(args)) return args[i] == null ? '' : String(args[i])
  return i === 0 && args != null ? String(args) : ''
}

const INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g
const VALIDATE_DELIMITERS = /[, /)(.;[\]"|:]+/

/** Applies a `filters:` chain to a value, exactly like Jackett's applyFilters. */
export function applyFilters(data: string, filters: FilterBlock[] | undefined, ctx: FilterContext): string {
  if (!filters) return data
  for (const f of filters) {
    const a = f.args
    switch (f.name) {
      case 'querystring':
        data = queryStringArg(data, arg(a))
        break
      case 'timeparse':
      case 'dateparse':
        try {
          data = parseDateLayout(data, arg(a)).toISOString()
        } catch (e) {
          ctx.log?.((e as Error).message)
        }
        break
      case 'regexp': {
        const m = dotnetRegex(arg(a)).exec(data)
        data = m?.[1] ?? ''
        break
      }
      case 're_replace':
        data = dotnetReplace(data, arg(a, 0), applyTemplate(arg(a, 1), ctx.vars))
        break
      case 'split': {
        const parts = data.split(arg(a, 0)[0] ?? '')
        let pos = Number.parseInt(arg(a, 1), 10)
        if (pos < 0) pos += parts.length
        if (pos < 0 || pos >= parts.length) throw new Error(`split: index ${arg(a, 1)} out of range for "${data}"`)
        data = parts[pos]
        break
      }
      case 'replace':
        data = data.split(arg(a, 0)).join(applyTemplate(arg(a, 1), ctx.vars))
        break
      case 'trim': {
        const cut = arg(a)
        if (cut) {
          const ch = cut[0]
          let s = 0
          let e = data.length
          while (s < e && data[s] === ch) s++
          while (e > s && data[e - 1] === ch) e--
          data = data.slice(s, e)
        } else data = data.trim()
        break
      }
      case 'prepend':
        data = applyTemplate(arg(a), ctx.vars) + data
        break
      case 'append':
        data = data + applyTemplate(arg(a), ctx.vars)
        break
      case 'tolower':
        data = data.toLowerCase()
        break
      case 'toupper':
        data = data.toUpperCase()
        break
      case 'base64decode':
        data = Buffer.from(data, 'base64').toString('utf8')
        break
      case 'base64encode':
        data = Buffer.from(data, 'utf8').toString('base64url')
        break
      case 'urldecode':
        data = urlDecode(data, ctx.encoding)
        break
      case 'urlencode':
        data = urlEncode(data, ctx.encoding)
        break
      case 'htmldecode':
        data = decodeHTML(data)
        break
      case 'htmlencode':
        data = encodeHTML(data)
        break
      case 'timeago':
      case 'reltime':
        data = fromTimeAgo(data).toISOString()
        break
      case 'fuzzytime':
        data = fromUnknown(data).toISOString()
        break
      case 'validfilename':
        data = data.replace(INVALID_FILENAME, '_')
        break
      case 'diacritics':
        if (arg(a) !== 'replace') throw new Error('unsupported diacritics filter argument')
        data = data.normalize('NFD').replace(/\p{Mn}/gu, '').normalize('NFC')
        break
      case 'jsonjoinarray': {
        const value = selectJsonPath(JSON.parse(data), arg(a, 0))
        data = Array.isArray(value) ? value.map(String).join(arg(a, 1)) : ''
        break
      }
      case 'validate': {
        const allowed = arg(a).toLowerCase().split(VALIDATE_DELIMITERS).filter(Boolean)
        const present = new Set(data.toLowerCase().split(VALIDATE_DELIMITERS).filter(Boolean))
        data = [...new Set(allowed)].filter((x) => present.has(x)).join(',')
        break
      }
      case 'hexdump':
      case 'strdump':
        ctx.log?.(`${f.name}: ${data}`)
        break
      default:
        break
    }
  }
  return data
}

/** Tiny JSONPath subset: `$.a.b`, `a[0].b`, `a['key with space']`. */
export function selectJsonPath(obj: unknown, path: string): unknown {
  const tokens: (string | number)[] = []
  const re = /\[(\d+)\]|\['([^']+)'\]|\["([^"]+)"\]|([^.[\]]+)/g
  for (const m of path.replace(/^\$\.?/, '').matchAll(re)) {
    if (m[1] !== undefined) tokens.push(Number(m[1]))
    else tokens.push(m[2] ?? m[3] ?? m[4])
  }
  let cur: unknown = obj
  for (const t of tokens) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string | number, unknown>)[t]
  }
  return cur
}
