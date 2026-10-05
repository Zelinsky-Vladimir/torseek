import { dotnetReplace } from './dotnet-regex'

// A deliberately faithful port of Jackett's "very bad implementation of the golang
// template engine". It is regex-based and order-dependent, and the definitions are
// written against exactly these quirks, so we don't try to be smarter than it.
//
// Supported: {{ .Var }}, {{ if .X }}a{{ else }}b{{ end }}, and/or/eq/ne,
// {{ range .List }}..{{.}}..{{end}}, {{ join .List "," }}, {{ re_replace .Var "re" "x" }}

export type VarValue = string | string[] | null | undefined
export type Vars = Record<string, VarValue>
export type Modifier = (s: string) => string

const LOGIC = /\b(and|or|eq|ne)(?:\s+(\(?\.[^)\s]+\)?|"[^"]+")){2,}/
const LOGIC_PARAM = /\s+(\(?\.[^)\s]+\)?|"[^"]+")/g
const RE_REPLACE = /{{\s*re_replace\s+(\..+?)\s+"(.*?)"\s+"(.*?)"\s*}}/g
const JOIN = /{{\s*join\s+(\..+?)\s+"(.*?)"\s*}}/g
const IF_ELSE = /{{\s*if\s*(.+?)\s*}}(.*?){{\s*else\s*}}(.*?){{\s*end\s*}}/g
const RANGE = /{{\s*range\s*(((?<index>\$.+?),)((\s*(?<element>.+?)\s*(:=)\s*)))?(?<variable>.+?)\s*}}(?<prefix>.*?){{\.}}(?<postfix>.*?){{end}}/g
const VARIABLE = /{{\s*(\..+?)\s*}}/g

const isBlank = (v: VarValue) => v == null || (typeof v === 'string' && v.trim() === '')
const asString = (v: VarValue) => (v == null ? '' : Array.isArray(v) ? v.join(',') : v)
const asList = (v: VarValue): string[] => (v == null ? [] : Array.isArray(v) ? v : [v])
const replaceAllLiteral = (s: string, find: string, repl: string) => s.split(find).join(repl)

export function applyTemplate(template: string | number | null | undefined, vars: Vars, modifier?: Modifier): string {
  if (template == null) return ''
  let t = String(template)
  if (!t.trim() || !t.includes('{{')) return t
  const mod = (s: string) => (modifier ? modifier(s) : s)

  for (const m of [...t.matchAll(RE_REPLACE)]) {
    const expanded = dotnetReplace(asString(vars[m[1]]), m[2], m[3])
    t = replaceAllLiteral(t, m[0], mod(expanded))
  }

  for (const m of [...t.matchAll(JOIN)]) {
    t = replaceAllLiteral(t, m[0], mod(asList(vars[m[1]]).join(m[2])))
  }

  // Re-run from the start after each replacement so nested calls resolve inside-out
  for (let m = LOGIC.exec(t); m; m = LOGIC.exec(t)) {
    const fn = m[1]
    const start = m.index
    let length = m[0].length
    const rest = m[0].slice(fn.length)
    const captures = [...rest.matchAll(LOGIC_PARAM)].map((c) => ({
      raw: c[1],
      index: start + fn.length + c.index + c[0].indexOf(c[1]),
    }))
    let params = captures.map((c) => c.raw.replace(/^\(+|\)+$/g, ''))
    let result = ''

    if (fn === 'and' || fn === 'or') {
      params = params.filter((p) => !p.startsWith('"'))
      const isAnd = fn === 'and'
      for (const p of params) {
        result = p
        if (isBlank(vars[p]) === isAnd) break
      }
    } else {
      if (captures.length > 2) length = captures[2].index - start
      const values = params.slice(0, 2).map((p) => (p.startsWith('"') ? p.replace(/^"|"$/g, '') : (vars[p] ?? null)))
      const equal = values[0] === values[1]
      result = equal === (fn === 'eq') ? '.True' : '.False'
    }
    t = t.slice(0, start) + result + t.slice(start + length)
  }

  for (const m of [...t.matchAll(IF_ELSE)]) {
    const condition = m[1]
    if (!condition.startsWith('.')) throw new Error(`Condition operation '${condition}' not implemented`)
    const value = vars[condition]
    const truthy = Array.isArray(value) ? value.length > 0 : !isBlank(value)
    t = replaceAllLiteral(t, m[0], truthy ? m[2] : m[3])
  }

  for (const m of [...t.matchAll(RANGE)]) {
    const g = m.groups!
    const indexReplace = `{{${g.index ?? ''}}}`
    let expanded = ''
    asList(vars[g.variable]).forEach((value, i) => {
      expanded += replaceAllLiteral(g.prefix, indexReplace, String(i)) + mod(value) + replaceAllLiteral(g.postfix, indexReplace, String(i))
    })
    t = replaceAllLiteral(t, m[0], expanded)
  }

  for (const m of [...t.matchAll(VARIABLE)]) {
    t = replaceAllLiteral(t, m[0], mod(asString(vars[m[1]])))
  }

  return t
}
