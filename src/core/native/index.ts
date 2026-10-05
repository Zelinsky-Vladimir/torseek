import type { Indexer } from '../indexer'
import type { NativeOptions } from './base'
import { RuTracker } from './rutracker'
import { Toloka } from './toloka'

// Hand-written indexers. Add new ones here.
export function createNativeIndexers(opts: NativeOptions): Indexer[] {
  return [new RuTracker(opts), new Toloka(opts)]
}
