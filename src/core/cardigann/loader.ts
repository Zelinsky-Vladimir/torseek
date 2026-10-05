import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { encodingSupported } from './encoding'
import type { Definition } from './types'

export interface LoadedDefinition {
  definition: Definition
  file: string
  /** Why the engine can't run it yet, if anything */
  unsupported?: string
}

export function parseDefinition(source: string): Definition {
  const def = loadYaml(source) as Definition
  if (!def?.id || !def.search || !def.links?.length) throw new Error('not a Cardigann definition')
  return def
}

function unsupportedReason(def: Definition): string | undefined {
  if (def.encoding && !encodingSupported(def.encoding)) return `encoding ${def.encoding}`
  return undefined
}

/** Load every *.yml in the given directories. Later dirs override earlier ones by id. */
export async function loadDefinitions(dirs: string[], onError?: (file: string, err: Error) => void): Promise<LoadedDefinition[]> {
  const byId = new Map<string, LoadedDefinition>()
  for (const dir of dirs) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names.filter((n) => n.endsWith('.yml') || n.endsWith('.yaml')).sort()) {
      const file = join(dir, name)
      try {
        const definition = parseDefinition(await readFile(file, 'utf8'))
        byId.set(definition.id, { definition, file, unsupported: unsupportedReason(definition) })
      } catch (e) {
        onError?.(file, e as Error)
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name))
}
