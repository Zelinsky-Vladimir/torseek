import type { Indexer } from '../indexer'
import type { NativeOptions } from './base'
import { Anilibria, AudioBookBay, Knaben, SubsPlease, TorrentsCsv } from './public'

// Hand-written indexers for public trackers the YAML format can't describe. Add new ones here.
export function createNativeIndexers(opts: NativeOptions): Indexer[] {
  return [new Knaben(opts), new TorrentsCsv(opts), new SubsPlease(opts), new Anilibria(opts), new AudioBookBay(opts)]
}
