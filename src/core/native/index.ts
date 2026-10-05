import type { Indexer } from '../indexer'
import type { NativeOptions } from './base'
import { Anilibria, AudioBookBay, Knaben, SubsPlease, TorrentsCsv } from './public'
import { RuTracker } from './rutracker'
import { Toloka } from './toloka'

// Hand-written indexers. Add new ones here.
export function createNativeIndexers(opts: NativeOptions): Indexer[] {
  return [new RuTracker(opts), new Toloka(opts), new Knaben(opts), new TorrentsCsv(opts), new SubsPlease(opts), new Anilibria(opts), new AudioBookBay(opts)]
}
