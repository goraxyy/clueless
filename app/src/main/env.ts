// Loads API keys from .env files at runtime. Keys are never bundled into the build.
import { existsSync, readFileSync } from 'node:fs'

/** Keys that came from a .env file (not the shell), so a later edit of the file can update them. */
const fromFiles = new Set<string>()

/**
 * Read KEY=VALUE lines into process.env. Earlier files and real env vars win. Called again while
 * the app runs, it picks up keys that were changed in the file since (a new ElevenLabs key, say).
 */
export function loadEnvFiles(files: string[]): string[] {
  const loaded: string[] = []
  const setNow = new Set<string>()
  for (const file of files) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      const [, key, rawValue] = m
      const value = rawValue.replace(/^(['"])(.*)\1$/, '$2')
      if (value === '' || setNow.has(key)) continue // empty, or an earlier file already set it
      if (process.env[key] !== undefined && !fromFiles.has(key)) continue // a real env var wins
      process.env[key] = value
      fromFiles.add(key)
      setNow.add(key)
    }
    loaded.push(file)
  }
  return loaded
}
