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
definitions/            Cardigann YAMLs from Jackett (all 584)
src/core/
  cardigann/            the engine: template, filters, dates, .NET regex compat, indexer
  categories.ts         Torznab category tree + per-tracker mapping
  search.ts             fan-out with concurrency, per-tracker timeout, streaming callbacks
  release.ts            result model, quality parsing, cross-tracker grouping
  http.ts               HTTP with cookie jar, manual redirects (catches magnet: redirects)
  indexer.ts            the Indexer interface both YAML and hand-written trackers implement
  native/               hand-written trackers (RuTracker, Toloka) + generated category tables
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
- **Release** (`.github/workflows/release.yml`): bump `version` in `package.json`, then
  `git tag v0.2.0 && git push origin v0.2.0`. All three installers are built and attached to a GitHub Release.
  Builds are unsigned for now (SmartScreen / Gatekeeper will warn).

## Status (v0.2)

Works:
- all **584 Jackett definitions** (public, semi-private, private) + hand-written **RuTracker** and **Toloka**
- **accounts**: Jackett-compatible login (form / post / get / cookie / oneurl), automatic re-login when a session
  expires, or **sign in in the browser** - a real browser window onto the site (captcha, 2FA, anything); the
  session is shared with the search engine. Credentials are encrypted at rest (Electron safeStorage)
- **Cloudflare / DDoS-Guard**: all tracker traffic runs on Chromium's network stack in one persistent session;
  for a protected site the user opens it once in the app's window, passes the check, and searches reuse it
- HTML / JSON / XML responses, Go-template subset, all Jackett filters, rows `after` / `dateheaders`
- download resolution: direct `.torrent`, magnet, `download.selectors`, `infohash`, `before` blocks
- results streaming, dedupe by info hash, quality badges, category / quality / seed filters
- built-in client: add, pause/resume, remove (+files), resume after restart, speed limits, seeding toggle
- **definitions auto-update** from the Jackett repo (daily, or Settings -> Update now); only changed files are fetched
- **installer**: `npm run dist` -> `dist/Torseek Setup x.y.z.exe` (NSIS); dmg / AppImage targets configured

Live check from this machine (all 86 public trackers enabled, query "dune"): 54 returned results, 16 answered
with nothing, 19 behind Cloudflare, 6 down or with broken TLS.

Not yet:
- other C#-only Jackett indexers (AnimeBytes, BakaBT, Gazelle-based sites, ...)
- code signing (Windows SmartScreen will warn), auto-update of the app itself
- per-torrent file list / selective download, streaming playback, magnet: link registration (opt-in setting)

## License

GPL-2.0. Tracker definitions come from [Jackett](https://github.com/Jackett/Jackett) (GPL-2.0).
