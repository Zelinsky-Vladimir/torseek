import { Menu, Tray, nativeImage } from 'electron'

// Tray icon: keeps the app reachable while the window is hidden and downloads continue.

export interface TrayActions {
  open: () => void
  pauseAll: () => void
  resumeAll: () => void
  quit: () => void
}

export interface TrayText {
  open: string
  pauseAll: string
  resumeAll: string
  quit: string
  tooltip: string
}

export class AppTray {
  private tray: Tray

  constructor(
    iconPath: string,
    private readonly actions: TrayActions,
  ) {
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    this.tray = new Tray(icon)
    this.tray.on('click', () => actions.open())
  }

  /** Rebuild menu and tooltip (language or active count changed). */
  update(text: TrayText) {
    this.tray.setToolTip(text.tooltip)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: text.open, click: () => this.actions.open() },
        { type: 'separator' },
        { label: text.pauseAll, click: () => this.actions.pauseAll() },
        { label: text.resumeAll, click: () => this.actions.resumeAll() },
        { type: 'separator' },
        { label: text.quit, click: () => this.actions.quit() },
      ]),
    )
  }

  destroy() {
    this.tray.destroy()
  }
}
