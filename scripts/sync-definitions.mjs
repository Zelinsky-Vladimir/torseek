#!/usr/bin/env node
// Pulls Cardigann tracker definitions from Jackett into ./definitions.
//
//   node scripts/sync-definitions.mjs                 # download from GitHub
//   node scripts/sync-definitions.mjs --from <dir>    # copy from a local Jackett checkout
//   node scripts/sync-definitions.mjs --types public,semi-private
//
// Definitions are GPL-2.0, same as this project.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'definitions')
const REPO_PATH = 'src/Jackett.Common/Definitions'

const args = process.argv.slice(2)
const argValue = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const from = argValue('--from')
// Only trackers that need no account: Torseek doesn't support sign-in
const types = (argValue('--types') ?? 'public').split(',')

const typeOf = (yml) => /^type:\s*([\w-]+)/m.exec(yml)?.[1]

async function* localSource(dir) {
  const base = join(dir, REPO_PATH)
  for (const name of await readdir(base)) {
    if (name.endsWith('.yml')) yield [name, await readFile(join(base, name), 'utf8')]
  }
}

async function* githubSource() {
  const res = await fetch(`https://api.github.com/repos/Jackett/Jackett/contents/${REPO_PATH}`, {
    headers: { 'User-Agent': 'torseek-sync' },
  })
  if (!res.ok) throw new Error(`GitHub API: ${res.status} ${await res.text()}`)
  const files = (await res.json()).filter((f) => f.name.endsWith('.yml'))
  // Small pool so we don't hammer raw.githubusercontent.com
  const queue = [...files]
  const results = []
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let f; (f = queue.shift()); ) {
        const r = await fetch(f.download_url)
        if (r.ok) results.push([f.name, await r.text()])
      }
    }),
  )
  yield* results
}

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

let kept = 0
let total = 0
for await (const [name, yml] of from ? localSource(from) : githubSource()) {
  total++
  if (!types.includes(typeOf(yml))) continue
  await writeFile(join(outDir, name), yml)
  kept++
}
console.log(`Synced ${kept}/${total} definitions (${types.join(', ')}) into definitions/`)
