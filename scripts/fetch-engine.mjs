#!/usr/bin/env node
// Downloads the torrent engine (rqbit, Apache-2.0, https://github.com/ikatson/rqbit) for a
// platform into build/bin/<platform>/, checking its SHA-256. electron-builder ships it
// as resources/bin; in development the app runs it from build/bin.
//
//   node scripts/fetch-engine.mjs             # this machine's platform
//   node scripts/fetch-engine.mjs win32 x64   # another one

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = 'v9.1.0'
const ASSETS = {
  'win32-x64': ['rqbit.exe', '9fb0c0dbe63ea7ca04611039e0244e570d115e79d3a0d4ac2bba22b9d80f3cbc'],
  'darwin-x64': ['rqbit-osx-universal', 'de978a3ddd9732181745a76d054faccd4df3e3caaae98e487292fea6637f1f73'],
  'darwin-arm64': ['rqbit-osx-universal', 'de978a3ddd9732181745a76d054faccd4df3e3caaae98e487292fea6637f1f73'],
  'linux-x64': ['rqbit-linux-amd64', '921061a82ee6a6b26754c6367886b5b6b4ce5916d3edd5db79c6cd5f2c23499f'],
  'linux-arm64': ['rqbit-linux-arm64', '5247a363df062f429e53661b7242373bf70603e93efc4d0b459017e6fd209def'],
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const platform = process.argv[2] ?? process.platform
const arch = process.argv[3] ?? process.arch
const entry = ASSETS[`${platform}-${arch}`]
if (!entry) {
  console.error(`No engine build for ${platform}-${arch}`)
  process.exit(1)
}
const [asset, sha256] = entry
const out = join(root, 'build', 'bin', platform, platform === 'win32' ? 'rqbit.exe' : 'rqbit')
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

if (existsSync(out) && sha(readFileSync(out)) === sha256) {
  console.log(`engine ${VERSION} already in ${out}`)
  process.exit(0)
}
const url = `https://github.com/ikatson/rqbit/releases/download/${VERSION}/${asset}`
const res = await fetch(url)
if (!res.ok) throw new Error(`${url}: ${res.status}`)
const data = Buffer.from(await res.arrayBuffer())
if (sha(data) !== sha256) throw new Error(`${asset}: checksum mismatch`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, data)
if (platform !== 'win32') chmodSync(out, 0o755)
writeFileSync(join(dirname(out), 'LICENSE-rqbit.txt'), `rqbit ${VERSION} — https://github.com/ikatson/rqbit\nCopyright 2021 Igor Katson\nLicensed under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0\n`)
console.log(`engine ${VERSION} -> ${out}`)
