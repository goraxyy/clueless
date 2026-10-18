import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnvFiles } from './env'

const dir = mkdtempSync(join(tmpdir(), 'clueless-env-'))
const file = (name: string, text: string): string => {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

describe('loadEnvFiles', () => {
  afterEach(() => {
    delete process.env.CLUELESS_TEST_KEY
    delete process.env.CLUELESS_TEST_SHELL
  })

  it('picks up a key edited in the file while the app runs, but never overrides the shell', () => {
    process.env.CLUELESS_TEST_SHELL = 'from-shell'
    const env = file('a.env', 'CLUELESS_TEST_KEY=old\nCLUELESS_TEST_SHELL=from-file\n')
    loadEnvFiles([env])
    expect(process.env.CLUELESS_TEST_KEY).toBe('old')
    writeFileSync(env, 'CLUELESS_TEST_KEY=new\nCLUELESS_TEST_SHELL=from-file\n')
    loadEnvFiles([env])
    expect(process.env.CLUELESS_TEST_KEY).toBe('new')
    expect(process.env.CLUELESS_TEST_SHELL).toBe('from-shell')
  })

  it('lets the earlier file win and skips empty values', () => {
    loadEnvFiles([file('b.env', 'CLUELESS_TEST_KEY=\n'), file('c.env', 'CLUELESS_TEST_KEY=first\n'), file('d.env', 'CLUELESS_TEST_KEY=second\n')])
    expect(process.env.CLUELESS_TEST_KEY).toBe('first')
  })
})
