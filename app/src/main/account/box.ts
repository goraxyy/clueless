// Keeps the sign-in session in a file in the user data folder, encrypted with the system keychain
// (safeStorage) where it's available.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import type { SecretBox } from './account'

export function fileBox(file: string): SecretBox {
  const encrypted = (): boolean => safeStorage.isEncryptionAvailable()
  return {
    read() {
      if (!existsSync(file)) return null
      try {
        const bytes = readFileSync(file)
        return encrypted() ? safeStorage.decryptString(bytes) : bytes.toString('utf8')
      } catch {
        return null // unreadable (a different machine's keychain, say): sign in again
      }
    },
    write(value) {
      if (value === null) return rmSync(file, { force: true })
      writeFileSync(file, encrypted() ? safeStorage.encryptString(value) : value, { mode: 0o600 })
    }
  }
}
