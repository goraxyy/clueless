// Updates from GitHub Releases (see publish in electron-builder.yml). Only in an installed build: a
// development run has nothing to update. On macOS only a signed app can update itself; an unsigned
// one logs the error and carries on.
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

const EVERY = 6 * 60 * 60 * 1000 // check again every 6 hours

export function keepUpdated(log: (line: string) => void): void {
  if (!app.isPackaged || process.env.CLUELESS_NO_UPDATES) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true // a downloaded update installs the next time Clueless quits
  autoUpdater.on('update-downloaded', (info) => log(`updates: ${info.version} downloaded, installs on quit`))
  const check = (): void => {
    autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => log(`updates: ${err instanceof Error ? err.message : String(err)}`))
  }
  check()
  setInterval(check, EVERY).unref()
}
