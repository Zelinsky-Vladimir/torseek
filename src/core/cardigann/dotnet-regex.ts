// Definitions were written against .NET regex semantics. The important differences
// from JS that actually show up in the YAMLs:
//  - inline option groups like `(?i)` at the start of a pattern
//  - `\w` and `\b` are Unicode-aware in .NET (matters for Cyrillic titles), ASCII in JS
//  - lone `{`, `}` and identity escapes like `\_` are legal in .NET, errors in JS `u` mode
//  - replacement strings use `${name}` / `$0` instead of `$<name>` / `$&`

const WORD = '\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}'
const WORD_BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`
const NOT_WORD_BOUNDARY = `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`
const SYNTAX_CHARS = new Set('^$\\.*+?()[]{}|/'.split(''))
const ESCAPE_LETTERS = new Set('dDsSnrtfvcxuk0123456789'.split(''))
const CLASS_ESCAPES = new Set('dDsSwW'.split(''))

interface Converted {
  source: string
  flags: string
}

function convertPattern(pattern: string): Converted {
  const flags = new Set<string>()
  let out = ''
  let inClass = false
  let prevWasClassEscape = false

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]

    if (c === '\\') {
      const n = pattern[i + 1]
      i++
      if (n === undefined) {
        out += '\\\\'
        continue
      }
      if (inClass) {
        if (n === 'w') {
          out += WORD
          prevWasClassEscape = true
        } else if (CLASS_ESCAPES.has(n)) {
          out += '\\' + n
          prevWasClassEscape = true
        } else if (n === 'p' || n === 'P') {
          const m = /^\{([^}]+)\}/.exec(pattern.slice(i + 1))
          if (m) {
            out += unicodeEscape(n, m[1], true)
            i += m[0].length
          } else out += n
        } else if (ESCAPE_LETTERS.has(n) || n === 'b' || n === '-' || n === ']' || n === '\\' || n === '^' || SYNTAX_CHARS.has(n)) {
          out += '\\' + n
        } else {
          out += n
        }
        continue
      }
      switch (n) {
        case 'w':
          out += `[${WORD}]`
          break
        case 'W':
          out += `[^${WORD}]`
          break
        case 'b':
          out += WORD_BOUNDARY
          break
        case 'B':
          out += NOT_WORD_BOUNDARY
          break
        case 'A':
          out += '^'
          break
        case 'Z':
        case 'z':
          out += '$'
          break
        case 'p':
        case 'P': {
          const m = /^\{([^}]+)\}/.exec(pattern.slice(i + 1))
          if (m) {
            out += unicodeEscape(n, m[1], false)
            i += m[0].length
          } else out += n
          break
        }
        default:
          if (ESCAPE_LETTERS.has(n) || SYNTAX_CHARS.has(n)) out += '\\' + n
          else out += n
      }
      continue
    }

    if (inClass) {
      if (c === ']') {
        inClass = false
        out += c
      } else if (c === '-' && prevWasClassEscape && pattern[i + 1] !== ']') {
        out += '\\-'
      } else if (c === '[' || c === '{' || c === '}' || c === '(' || c === ')' || c === '|' || c === '/') {
        out += '\\' + c
      } else {
        out += c
      }
      prevWasClassEscape = false
      continue
    }

    if (c === '[') {
      inClass = true
      out += c
      // `[]...]` and `[^]...]` treat the first `]` as a literal in .NET
      if (pattern[i + 1] === '^') {
        out += '^'
        i++
      }
      if (pattern[i + 1] === ']') {
        out += '\\]'
        i++
      }
      continue
    }

    if (c === '(' && pattern[i + 1] === '?') {
      const rest = pattern.slice(i)
      const inline = /^\(\?([imsxn]+)\)/.exec(rest)
      if (inline) {
        for (const f of inline[1]) if ('ims'.includes(f)) flags.add(f)
        i += inline[0].length - 1
        continue
      }
      const comment = /^\(\?#[^)]*\)/.exec(rest)
      if (comment) {
        i += comment[0].length - 1
        continue
      }
      const quotedName = /^\(\?'([A-Za-z_]\w*)'/.exec(rest)
      if (quotedName) {
        out += `(?<${quotedName[1]}>`
        i += quotedName[0].length - 1
        continue
      }
    }

    if (c === '{') {
      const q = /^\{\d+(,\d*)?\}/.exec(pattern.slice(i))
      if (q) {
        out += q[0]
        i += q[0].length - 1
      } else out += '\\{'
      continue
    }
    if (c === '}' || c === ']' || c === '/') {
      out += '\\' + c
      continue
    }
    out += c
  }
  return { source: out, flags: [...flags].join('') }
}

// .NET `\p{IsXxx}` names Unicode *blocks*, which JS has no syntax for
const BLOCKS: Record<string, string> = {
  BasicLatin: '\\u0000-\\u007F',
  'Latin-1Supplement': '\\u0080-\\u00FF',
  Greek: '\\u0370-\\u03FF',
  Cyrillic: '\\u0400-\\u04FF',
  CyrillicSupplement: '\\u0500-\\u052F',
  Hebrew: '\\u0590-\\u05FF',
  Arabic: '\\u0600-\\u06FF',
  Thai: '\\u0E00-\\u0E7F',
  Hiragana: '\\u3040-\\u309F',
  Katakana: '\\u30A0-\\u30FF',
  CJKUnifiedIdeographs: '\\u4E00-\\u9FFF',
  HangulSyllables: '\\uAC00-\\uD7AF',
}

function unicodeEscape(kind: string, name: string, inClass: boolean): string {
  const block = /^Is(.+)$/.exec(name)
  if (!block) return `\\${kind}{${name}}`
  const range = BLOCKS[block[1]]
  if (!range) throw new Error(`Unsupported Unicode block ${name}`)
  if (inClass) {
    if (kind === 'P') throw new Error(`Negated Unicode block ${name} inside a class`)
    return range
  }
  return kind === 'P' ? `[^${range}]` : `[${range}]`
}

const cache = new Map<string, RegExp>()

/** Compile a .NET-flavoured pattern. `extraFlags` like 'g'. */
export function dotnetRegex(pattern: string, extraFlags = ''): RegExp {
  const key = extraFlags + '\u0000' + pattern
  const hit = cache.get(key)
  if (hit) {
    hit.lastIndex = 0
    return hit
  }
  let re: RegExp
  try {
    const { source, flags } = convertPattern(pattern)
    re = new RegExp(source, uniq(flags + extraFlags + 'u'))
  } catch {
    // Fall back to the raw pattern without Unicode mode; loses \w/\b fidelity but works
    const stripped = pattern.replace(/^\(\?([imsxn]+)\)/, '')
    const lead = /^\(\?([imsxn]+)\)/.exec(pattern)?.[1].replace(/[xn]/g, '') ?? ''
    re = new RegExp(stripped, uniq(lead + extraFlags))
  }
  cache.set(key, re)
  return re
}

const uniq = (flags: string) => [...new Set(flags)].join('')

/** .NET replacement syntax -> JS replacement syntax. */
export function dotnetReplacement(replacement: string): string {
  return replacement.replace(/\$(\$|\{(\w+)\}|0|_|\+)/g, (all, token: string, braced?: string) => {
    if (token === '$') return '$$'
    if (token === '0') return '$&'
    if (token === '_' || token === '+') return '$$' + token
    if (braced !== undefined) return /^\d+$/.test(braced) ? `$${braced}` : `$<${braced}>`
    return all
  })
}

/** Regex.Replace(input, pattern, replacement) with .NET semantics (replaces all). */
export function dotnetReplace(input: string, pattern: string, replacement: string): string {
  return input.replace(dotnetRegex(pattern, 'g'), dotnetReplacement(replacement))
}
