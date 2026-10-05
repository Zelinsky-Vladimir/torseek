#!/usr/bin/env node
// Adds keys to every locale file from a JSON batch: { "key": { "en": "...", "ru": "...", ... } }
//   node scripts/add-i18n-keys.mjs batch.json [section comment]
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/shared/i18n')
const [file, section = 'added'] = process.argv.slice(2)
const batch = JSON.parse(readFileSync(file, 'utf8'))
const langs = ['en', 'ru', 'uk', 'es', 'pt', 'fr', 'de', 'it', 'pl', 'tr', 'zh', 'ja', 'ko']

for (const lang of langs) {
  const path = join(dir, `${lang}.ts`)
  let src = readFileSync(path, 'utf8')
  const lines = []
  for (const [key, tr] of Object.entries(batch)) {
    if (!tr[lang]) throw new Error(`${key}: missing ${lang}`)
    if (src.includes(`'${key}':`) || src.includes(`"${key}":`)) continue
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(tr[lang])},`)
  }
  if (!lines.length) continue
  const close = src.lastIndexOf('\n}')
  src = src.slice(0, close) + `\n\n  // ${section}\n` + lines.join('\n') + src.slice(close)
  writeFileSync(path, src)
}
console.log(`added ${Object.keys(batch).length} keys to ${langs.length} locales`)
