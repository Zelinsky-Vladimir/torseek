# Torseek

Desktop meta-search for torrent trackers with a built-in BitTorrent client.
Type once, every enabled tracker is queried in parallel, results stream in as
each site answers, duplicates across trackers are merged, and the download
button starts the torrent right inside the app.

The search engine is a TypeScript port of Jackett's Cardigann interpreter, so it
runs Jackett's community-maintained YAML tracker definitions unchanged.

## Stack

- **Electron 44** + electron-vite, **React 19**, Tailwind 4, zustand
- **Core engine** (`src/core`): pure Node, no Electron imports. Testable and usable from the CLI
- **Torrent client**: WebTorrent 3 (pure JS: TCP/uTP, DHT, PEX, trackers)

## Layout

```
definitions/            public Cardigann YAMLs from Jackett (86)
src/core/
  torznab.ts            Torznab API server (Sonarr / Radarr)
  filters.ts            result filters shared by the UI and watched searches
  cardigann/            the engine: template, filters, dates, .NET regex compat, indexer
  categories.ts         Torznab category tree + per-tracker mapping
  search.ts             fan-out with concurrency, per-tracker timeout, streaming callbacks
  release.ts            result model, quality parsing, cross-tracker grouping
  http.ts               HTTP with cookie jar, manual redirects (catches magnet: redirects)
  indexer.ts            the Indexer interface both YAML and hand-written trackers implement
  native/               hand-written public trackers (Knaben, Torrents.csv, …) + generated category tables
src/main/               Electron main: IPC API, tracker manager, torrent manager, JSON store,
                        Chromium networking (net.ts), site windows, definitions updater
src/preload/            contextBridge -> window.api
src/renderer/           UI (runs in a plain browser with a mock API too)
src/shared/api.ts       typed contract between UI and main
scripts/                cli-search, sync-definitions, e2e-smoke
```

## Commands

```bash
npm install
npx install-electron          # npm 11 doesn't run electron's install script
npm run dev                   # app with hot reload
npm run build                 # production build into out/
npm test                      # engine unit tests
npm run search -- "dune" --resolve           # search from the terminal, resolve downloads
npm run search -- "dune" --only rutor --debug
npm run dist                  # Windows installer into dist/
node scripts/e2e-trackers.mjs dune --open 1337x   # all public trackers + open a protected site
npm run sync-definitions      # pull latest definitions from Jackett on GitHub
node scripts/e2e-smoke.mjs "ubuntu 26.04"    # drive the built app: search -> download
node scripts/e2e-client.mjs     # file selection, tray (legal test torrent)
node scripts/e2e-library.mjs    # title card, favorites, watch, history
node scripts/e2e-torznab.mjs    # Torznab API the way Sonarr calls it
```

## Languages

The UI ships in 13 languages: English, Русский, Українська, Español, Português, Français, Deutsch,
Italiano, Polski, Türkçe, 简体中文, 日本語, 한국어. The system language is picked automatically and can be
changed in Settings. Dictionaries live in `src/shared/i18n/` (one file per language, `en.ts` is the
source); TypeScript fails the build if a key is missing, and `test/i18n.test.ts` checks placeholders
and plural forms. To add a language: copy `en.ts`, translate, register it in `src/shared/i18n/index.ts`.
Right-to-left languages (Arabic, Hebrew) need layout work first.

## CI and releases

- **CI** (`.github/workflows/ci.yml`): every push to `main` and every PR runs typecheck, tests and a build,
  then packages installers for Windows (NSIS), macOS (dmg, arm64 + x64) and Linux (AppImage) as artifacts.
- **Release** (`.github/workflows/release.yml`): every push to `main` is released - the next patch version
  (or `package.json`'s version when you bumped minor/major there), all three installers attached to a GitHub
  Release; installed apps check for it every minute. `[skip release]` in the commit message skips it.
  Builds are unsigned for now (SmartScreen / Gatekeeper will warn).

## Features

**Search**
- **public trackers only** - nothing to register for, no invites: the 86 public Jackett definitions plus
  hand-written **Knaben, Torrents.csv, SubsPlease, Anilibria, AudioBook Bay**
- **search in other languages**: type «дюна» and English trackers also get "Dune", Chinese ones "沙丘" (titles from Wikidata)
- streaming results, duplicates merged across trackers, quality badges, category / quality / seed filters
- **audio and subtitle filters** (English / Russian / Ukrainian), from release names, and **"check tracks"**: reads the
  real audio/subtitle tracks from the MKV/MP4 header in seconds without downloading the release (also shown in Downloads)
- loose matches the trackers pad results with are tucked away
- trackers checked daily: working ones in your languages switched on, dead ones off
- **movie & series cards** (poster, year, IMDb rating, releases by quality) from Cinemeta - optional
- **favorites**, **search history**, **watched searches**: re-checked in the background, notification on new releases

**Protection pages**
- Cloudflare / DDoS-Guard: Chromium network stack in one shared session; open the site once in the app's window

**Client**
- choose files in a torrent, open finished files, ask where to save (or always use one folder)
- a list of live public trackers is added to every torrent, so magnets with dead trackers still start;
  DHT bootstraps from five routers and remembers its nodes between runs
- tray icon, keeps downloading when the window is closed, notifications, start with the OS, magnet link handler
- speed limits, seeding toggle, resume after restart

**Integration & updates**
- **Torznab API** for Sonarr / Radarr / Lidarr / Prowlarr (Jackett-compatible URLs, local only, API key)
- tracker definitions auto-update daily from the Jackett repo; the app self-updates from GitHub Releases (Windows/Linux)
- UI in 13 languages; 6 color themes (plus follow-the-system) and 7 accent colors

Not yet: other C#-only Jackett indexers (AnimeBytes, Gazelle-based sites, Spanish sites), code signing,
macOS self-update (needs signing), right-to-left languages.

## License

GPL-2.0. Tracker definitions come from [Jackett](https://github.com/Jackett/Jackett) (GPL-2.0).
