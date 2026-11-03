import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowlistSource } from './allowlist'

describe('server allowlist', () => {
  it("matches the app's prompts and schemas (run `npm run allowlist` after changing one)", () => {
    const file = join(__dirname, '..', '..', '..', '..', 'supabase', 'functions', '_shared', 'allowlist.ts')
    expect(readFileSync(file, 'utf8')).toBe(allowlistSource())
  })
})
