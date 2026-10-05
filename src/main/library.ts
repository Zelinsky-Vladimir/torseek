import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ResultFilters } from '../core/filters'
import { groupKey, type Release } from '../core/release'
import type { FavoriteItem, HistoryItem, Watch, WatchHit } from '../shared/api'

// Search history, favorites and watched searches in SQLite (Node's built-in driver, so
// no native module to rebuild per Electron version).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
  query TEXT PRIMARY KEY COLLATE NOCASE,
  results INTEGER NOT NULL DEFAULT 0,
  searched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
  key TEXT PRIMARY KEY,
  release TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  filters TEXT NOT NULL,
  title TEXT,
  poster TEXT,
  created_at INTEGER NOT NULL,
  checked_at INTEGER
);
CREATE TABLE IF NOT EXISTS watch_results (
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  release TEXT NOT NULL,
  found_at INTEGER NOT NULL,
  -- results that existed when the watch was created are baseline, not news
  baseline INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (watch_id, key)
);
`

export class Library {
  private db: DatabaseSync

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  // --- history ---

  addHistory(query: string, results: number) {
    const q = query.trim()
    if (!q) return
    this.db
      .prepare('INSERT INTO history (query, results, searched_at) VALUES (?, ?, ?) ON CONFLICT(query) DO UPDATE SET results = excluded.results, searched_at = excluded.searched_at')
      .run(q, results, Date.now())
    // Keep the table small
    this.db.prepare('DELETE FROM history WHERE query NOT IN (SELECT query FROM history ORDER BY searched_at DESC LIMIT 500)').run()
  }

  history(limit = 100): HistoryItem[] {
    return (this.db.prepare('SELECT query, results, searched_at FROM history ORDER BY searched_at DESC LIMIT ?').all(limit) as {
      query: string
      results: number
      searched_at: number
    }[]).map((r) => ({ query: r.query, results: r.results, searchedAt: r.searched_at }))
  }

  removeHistory(query: string) {
    this.db.prepare('DELETE FROM history WHERE query = ?').run(query)
  }

  clearHistory() {
    this.db.exec('DELETE FROM history')
  }

  // --- favorites ---

  addFavorite(release: Release) {
    this.db.prepare('INSERT OR REPLACE INTO favorites (key, release, added_at) VALUES (?, ?, ?)').run(groupKey(release), JSON.stringify(release), Date.now())
  }

  removeFavorite(key: string) {
    this.db.prepare('DELETE FROM favorites WHERE key = ?').run(key)
  }

  favorites(): FavoriteItem[] {
    return (this.db.prepare('SELECT key, release, added_at FROM favorites ORDER BY added_at DESC').all() as { key: string; release: string; added_at: number }[]).map(
      (r) => ({ key: r.key, release: JSON.parse(r.release), addedAt: r.added_at }),
    )
  }

  favoriteKeys(): string[] {
    return (this.db.prepare('SELECT key FROM favorites').all() as { key: string }[]).map((r) => r.key)
  }

  // --- watched searches ---

  addWatch(query: string, filters: ResultFilters, meta: { title?: string; poster?: string } = {}): number {
    const res = this.db
      .prepare('INSERT INTO watches (query, filters, title, poster, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(query.trim(), JSON.stringify(filters), meta.title ?? null, meta.poster ?? null, Date.now())
    return Number(res.lastInsertRowid)
  }

  removeWatch(id: number) {
    this.db.prepare('DELETE FROM watches WHERE id = ?').run(id)
  }

  watches(): Watch[] {
    const rows = this.db
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM watch_results r WHERE r.watch_id = w.id AND r.baseline = 0 AND r.seen = 0) AS new_count
         FROM watches w ORDER BY w.created_at DESC`,
      )
      .all() as { id: number; query: string; filters: string; title: string | null; poster: string | null; created_at: number; checked_at: number | null; new_count: number }[]
    return rows.map((r) => ({
      id: r.id,
      query: r.query,
      filters: JSON.parse(r.filters),
      title: r.title ?? undefined,
      poster: r.poster ?? undefined,
      createdAt: r.created_at,
      checkedAt: r.checked_at ?? undefined,
      newCount: r.new_count,
    }))
  }

  watch(id: number): Watch | undefined {
    return this.watches().find((w) => w.id === id)
  }

  dueWatches(intervalMs: number): Watch[] {
    const now = Date.now()
    return this.watches().filter((w) => !w.checkedAt || now - w.checkedAt >= intervalMs)
  }

  /**
   * Store the results of a check. On the first check everything is baseline (already
   * available when the user started watching); later, unknown results are new.
   * Returns the newly found releases.
   */
  recordCheck(id: number, releases: Release[]): Release[] {
    const watch = this.watch(id)
    if (!watch) return []
    const baseline = watch.checkedAt ? 0 : 1
    const insert = this.db.prepare('INSERT OR IGNORE INTO watch_results (watch_id, key, release, found_at, baseline) VALUES (?, ?, ?, ?, ?)')
    const fresh: Release[] = []
    const now = Date.now()
    this.db.exec('BEGIN')
    try {
      for (const r of releases) {
        const res = insert.run(id, groupKey(r), JSON.stringify(r), now, baseline)
        if (res.changes > 0 && !baseline) fresh.push(r)
      }
      this.db.prepare('UPDATE watches SET checked_at = ? WHERE id = ?').run(now, id)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return fresh
  }

  /** New (non-baseline) results, newest first. */
  hits(id: number): WatchHit[] {
    return (this.db
      .prepare('SELECT key, release, found_at, seen FROM watch_results WHERE watch_id = ? AND baseline = 0 ORDER BY found_at DESC LIMIT 300')
      .all(id) as { key: string; release: string; found_at: number; seen: number }[]).map((r) => ({
      key: r.key,
      release: JSON.parse(r.release),
      foundAt: r.found_at,
      seen: !!r.seen,
    }))
  }

  markSeen(id: number) {
    this.db.prepare('UPDATE watch_results SET seen = 1 WHERE watch_id = ?').run(id)
  }

  close() {
    this.db.close()
  }
}
