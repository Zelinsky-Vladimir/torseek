import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Tiny JSON-file store. Writes are debounced and atomic (write tmp + rename).
// Good enough until we need queries; then this becomes SQLite.

export class JsonStore<T extends object> {
  private data: T
  private timer?: NodeJS.Timeout

  constructor(
    private readonly file: string,
    defaults: T,
  ) {
    let loaded: Partial<T> = {}
    try {
      loaded = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      /* first run or corrupt file: start from defaults */
    }
    this.data = { ...defaults, ...loaded }
  }

  get(): T {
    return this.data
  }

  update(fn: (data: T) => void) {
    fn(this.data)
    this.scheduleSave()
  }

  private scheduleSave() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 300)
  }

  flush() {
    clearTimeout(this.timer)
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }
}
