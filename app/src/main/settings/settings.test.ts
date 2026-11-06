import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOTKEYS, SettingsStore } from './settings'

const file = (): string => join(mkdtempSync(join(tmpdir(), 'clueless-settings-')), 'settings.json')

describe('SettingsStore', () => {
  it('starts with the defaults and keeps changes across restarts', () => {
    const path = file()
    const store = new SettingsStore(path)
    expect(store.current).toEqual({ hotkeys: DEFAULT_HOTKEYS, askOnHighlight: true, firstRunDone: false })
    store.update({ hotkeys: { ...store.current.hotkeys, ask: 'Alt+Space' }, firstRunDone: true })
    expect(new SettingsStore(path).current).toMatchObject({ hotkeys: { ask: 'Alt+Space', area: DEFAULT_HOTKEYS.area }, firstRunDone: true })
  })

  it('ignores a garbled or tampered file field by field', () => {
    const path = file()
    writeFileSync(path, JSON.stringify({ hotkeys: { ask: 'rm -rf', area: 'Alt+2' }, askOnHighlight: 'yes' }))
    expect(new SettingsStore(path).current).toEqual({
      hotkeys: { ...DEFAULT_HOTKEYS, area: 'Alt+2' },
      askOnHighlight: true,
      firstRunDone: false
    })
    writeFileSync(path, '{not json')
    expect(new SettingsStore(path).current.hotkeys).toEqual(DEFAULT_HOTKEYS)
    expect(readFileSync(path, 'utf8')).toBe('{not json') // not rewritten until something changes
  })

  it('refuses shortcuts that would break typing or clash with another Clueless shortcut', () => {
    const store = new SettingsStore(null)
    expect(store.hotkeyProblem('ask', 'K')).toBe('Use Cmd/Ctrl or Alt with one other key.')
    expect(store.hotkeyProblem('ask', 'Shift+K')).toBe('Use Cmd/Ctrl or Alt with one other key.')
    expect(store.hotkeyProblem('ask', DEFAULT_HOTKEYS.island)).toBe('Another Clueless shortcut already uses that.')
    expect(store.hotkeyProblem('ask', DEFAULT_HOTKEYS.ask)).toBeNull() // setting it back to itself is fine
    expect(store.hotkeyProblem('ask', 'CommandOrControl+Alt+/')).toBeNull()
  })
})
