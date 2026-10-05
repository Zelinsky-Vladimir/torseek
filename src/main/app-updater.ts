import { app } from 'electron'
import updaterPkg from 'electron-updater'
import type { UpdateStatus } from '../shared/api'

// Self-update from GitHub Releases (electron-updater reads latest*.yml that the release
// workflow attaches). Downloads in the background (only the changed blocks, via the
// .blockmap files), installs silently over the current copy on restart or quit.
// Unsigned macOS builds can't self-update; Windows NSIS and Linux AppImage can.

const { autoUpdater } = updaterPkg

export class AppUpdater {
  status: UpdateStatus = { state: 'idle', version: app.getVersion() }

  constructor(private readonly onChange: (s: UpdateStatus) => void) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'latest' }))
    autoUpdater.on('update-available', (info) => this.set({ state: 'downloading', available: info.version, percent: 0 }))
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', available: info.version }))
    autoUpdater.on('error', (e) => this.set({ state: 'error', error: e?.message ?? String(e) }))
  }

  get supported() {
    return app.isPackaged && process.platform !== 'darwin'
  }

  private set(patch: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...patch }
    if (patch.state !== 'error') delete this.status.error
    this.onChange(this.status)
  }

  async check(): Promise<UpdateStatus> {
    if (!this.supported) {
      this.set({ state: 'unsupported' })
      return this.status
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      this.set({ state: 'error', error: (e as Error).message })
    }
    return this.status
  }

  install() {
    // Silent per-user installer: replaces the app in place and starts it again, no wizard
    if (this.status.state === 'ready') autoUpdater.quitAndInstall(true, true)
  }
}
