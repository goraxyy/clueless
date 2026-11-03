// Where the sign-in is kept between launches: a file in the app's data folder, encrypted with a key
// the OS keeps for Clueless (the macOS Keychain, Windows DPAPI). Other apps can't read it.
import { safeStorage } from 'electron'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

export class EncryptedFileStorage {
  private items: Record<string, string> = {}

  constructor(private readonly file: string) {
    if (!safeStorage.isEncryptionAvailable()) return
    try {
      this.items = JSON.parse(safeStorage.decryptString(readFileSync(file)))
    } catch {
      // no file yet, or it can't be read: start signed out
    }
  }

  getItem(key: string): string | null {
    return this.items[key] ?? null
  }

  setItem(key: string, value: string): void {
    this.items[key] = value
    this.save()
  }

  removeItem(key: string): void {
    delete this.items[key]
    this.save()
  }

  private save(): void {
    // Without OS encryption (some Linux setups) the sign-in stays in memory: sign in each launch.
    if (!safeStorage.isEncryptionAvailable()) return
    if (!Object.keys(this.items).length) {
      rmSync(this.file, { force: true })
      return
    }
    writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(this.items)), { mode: 0o600 })
  }
}
