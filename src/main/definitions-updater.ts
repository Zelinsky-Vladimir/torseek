import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Keeps tracker definitions fresh between app releases. Sites change domains and markup
// constantly and the Jackett community fixes the YAMLs almost daily, so we pull them
// straight from the Jackett repo into the user definitions folder (which overrides the
// bundled copy). One GitHub API call lists the folder with git blob hashes; only files
// whose hash differs from what we already have are downloaded.

const LISTING = 'https://api.github.com/repos/Jackett/Jackett/contents/src/Jackett.Common/Definitions?ref=master'
const MANIFEST = '.manifest.json'

interface Manifest {
  checkedAt: number
  /** files we downloaded: name -> git blob sha */
  files: Record<string, string>
}

export interface UpdateResult {
  checkedAt: number
  updated: number
  added: number
  removed: number
  total: number
}

const gitBlobSha = (data: Buffer) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')

export class DefinitionsUpdater {
  constructor(
    private readonly bundledDir: string,
    private readonly userDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async manifest(): Promise<Manifest> {
    try {
      return JSON.parse(await readFile(join(this.userDir, MANIFEST), 'utf8'))
    } catch {
      return { checkedAt: 0, files: {} }
    }
  }

  async lastChecked(): Promise<number> {
    return (await this.manifest()).checkedAt
  }

  private async localSha(name: string): Promise<string | undefined> {
    for (const dir of [this.userDir, this.bundledDir]) {
      try {
        return gitBlobSha(await readFile(join(dir, name)))
      } catch {
        /* not in this dir */
      }
    }
    return undefined
  }

  async update(): Promise<UpdateResult> {
    const res = await this.fetchImpl(LISTING, { headers: { 'User-Agent': 'torseek', Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`GitHub: ${res.status} ${res.statusText}`)
    const remote = ((await res.json()) as { name: string; sha: string; download_url: string }[]).filter((f) => f.name.endsWith('.yml'))
    if (remote.length < 100) throw new Error(`GitHub listing looks truncated (${remote.length} files)`)

    await mkdir(this.userDir, { recursive: true })
    const manifest = await this.manifest()
    const result: UpdateResult = { checkedAt: Date.now(), updated: 0, added: 0, removed: 0, total: remote.length }

    const stale: typeof remote = []
    for (const f of remote) {
      const local = await this.localSha(f.name)
      if (local !== f.sha) stale.push(f)
      if (local === undefined) result.added++
      else if (local !== f.sha) result.updated++
    }

    const queue = [...stale]
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          const r = await this.fetchImpl(f.download_url)
          if (!r.ok) throw new Error(`download ${f.name}: ${r.status}`)
          const data = Buffer.from(await r.arrayBuffer())
          await writeFile(join(this.userDir, f.name), data)
          manifest.files[f.name] = gitBlobSha(data)
        }
      }),
    )

    // Definitions removed upstream: drop our downloaded copies (hand-made files are kept)
    const names = new Set(remote.map((f) => f.name))
    for (const name of await readdir(this.userDir)) {
      if (manifest.files[name] && !names.has(name)) {
        await rm(join(this.userDir, name), { force: true })
        delete manifest.files[name]
        result.removed++
      }
    }

    manifest.checkedAt = result.checkedAt
    await writeFile(join(this.userDir, MANIFEST), JSON.stringify(manifest, null, 1))
    return result
  }
}
