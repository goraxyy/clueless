import { describe, expect, it } from 'vitest'
import type { UpdateView } from '../../shared/contracts'
import { Updates, type UpdaterLike } from './updates'

class FakeUpdater implements UpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = false
  checks = 0
  installed = 0
  failCheck = false
  private listeners = new Map<string, (arg: never) => void>()
  on(event: string, listener: (arg: never) => void): this {
    this.listeners.set(event, listener)
    return this
  }
  emit(event: string, arg: unknown): void {
    this.listeners.get(event)?.(arg as never)
  }
  async checkForUpdates(): Promise<void> {
    this.checks++
    if (this.failCheck) throw new Error('net::ERR_INTERNET_DISCONNECTED\nstack...')
  }
  quitAndInstall(): void {
    this.installed++
  }
}

function setup() {
  const updater = new FakeUpdater()
  const views: UpdateView[] = []
  const logs: string[] = []
  const updates = new Updates(updater, (v) => views.push(v), (l) => logs.push(l))
  return { updater, views, logs, updates }
}

describe('Updates', () => {
  it('downloads in the background and offers a restart once ready', async () => {
    const { updater, views, updates } = setup()
    updates.start(60_000)
    expect(updater.autoDownload && updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.checks).toBe(1)

    updater.emit('update-available', { version: '0.2.0' })
    expect(updates.current).toEqual({ version: '0.2.0', state: 'downloading' })
    updates.install() // not ready yet: nothing happens
    expect(updater.installed).toBe(0)

    updater.emit('update-downloaded', { version: '0.2.0' })
    expect(views.at(-1)).toEqual({ version: '0.2.0', state: 'ready' })
    updates.install()
    expect(updater.installed).toBe(1)
    updates.stop()
  })

  it('stays quiet when offline or when the download fails', async () => {
    const { updater, logs, updates } = setup()
    updater.failCheck = true
    updates.start(60_000)
    await Promise.resolve()
    expect(updates.current).toBeNull()
    expect(logs).toEqual(['update: net::ERR_INTERNET_DISCONNECTED'])

    updater.emit('update-available', { version: '0.2.0' })
    updater.emit('error', new Error('Could not get code signature for running application'))
    expect(updates.current).toBeNull()
    updates.stop()
  })
})
