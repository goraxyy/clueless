// Updates: a new version downloads in the background from GitHub Releases (electron-updater), and
// the panel offers "Restart to update". Quitting also installs it. No Electron imports: the updater
// is passed in, so the tests use a fake.
import type { UpdateView } from '../../shared/contracts'

/** The slice of electron-updater's autoUpdater this uses. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

const SIX_HOURS = 6 * 60 * 60 * 1000

export class Updates {
  private view: UpdateView = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly updater: UpdaterLike,
    private readonly onChange: (view: UpdateView) => void,
    private readonly log: (line: string) => void = () => {}
  ) {}

  get current(): UpdateView {
    return this.view
  }

  /** Check now and every few hours. */
  start(everyMs = SIX_HOURS): void {
    this.updater.autoDownload = true
    this.updater.autoInstallOnAppQuit = true
    this.updater.on('update-available', (info) => this.set({ version: info.version, state: 'downloading' }))
    this.updater.on('update-downloaded', (info) => this.set({ version: info.version, state: 'ready' }))
    this.updater.on('error', (err) => {
      // Offline, GitHub down, or (on a Mac build that isn't signed yet) the update can't be installed.
      this.log(`update: ${err.message.split('\n')[0]}`)
      if (this.view?.state === 'downloading') this.set(null)
    })
    void this.check()
    this.timer = setInterval(() => void this.check(), everyMs)
  }

  /** Quit, install and reopen. */
  install(): void {
    if (this.view?.state === 'ready') this.updater.quitAndInstall()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private async check(): Promise<void> {
    if (this.view?.state === 'ready') return // already waiting for a restart
    try {
      await this.updater.checkForUpdates()
    } catch (err) {
      this.log(`update: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  private set(view: UpdateView): void {
    this.view = view
    this.onChange(view)
  }
}
