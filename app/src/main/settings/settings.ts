// The student's settings, kept in the app's data folder (they used to live in .env): hotkeys, the
// Ask-on-highlight switch, and whether the first-run walkthrough is done. The panel's look
// (transparency, size) and the voice choices stay in the window's own storage.
// No Electron imports, so it's unit-testable.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HotkeyName, Hotkeys } from '../../shared/contracts'

export const DEFAULT_HOTKEYS: Hotkeys = {
  ask: 'CommandOrControl+Shift+Space',
  area: 'CommandOrControl+Shift+2',
  voice: 'CommandOrControl+Shift+1',
  island: 'CommandOrControl+Shift+3'
}

export interface Settings {
  hotkeys: Hotkeys
  askOnHighlight: boolean
  firstRunDone: boolean
}

const DEFAULTS: Settings = { hotkeys: DEFAULT_HOTKEYS, askOnHighlight: true, firstRunDone: false }
const NAMES = Object.keys(DEFAULT_HOTKEYS) as HotkeyName[]
/** A modifier (Cmd/Ctrl or Alt, Shift optional) and one key, the way Electron writes them. */
const ACCELERATOR = /^(CommandOrControl|Control|Alt)(\+(Control|Alt|Shift))*\+[A-Za-z0-9]+$|^(CommandOrControl|Control|Alt)(\+(Control|Alt|Shift))*\+[-=[\];',./\\`]$/

export const isAccelerator = (value: unknown): value is string => typeof value === 'string' && value.length <= 60 && ACCELERATOR.test(value)

export class SettingsStore {
  private data: Settings = structuredClone(DEFAULTS)

  constructor(private readonly file: string | null) {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>
      const hotkeys = { ...DEFAULT_HOTKEYS }
      for (const name of NAMES) if (isAccelerator(raw.hotkeys?.[name])) hotkeys[name] = raw.hotkeys![name]
      this.data = {
        hotkeys,
        askOnHighlight: typeof raw.askOnHighlight === 'boolean' ? raw.askOnHighlight : DEFAULTS.askOnHighlight,
        firstRunDone: raw.firstRunDone === true
      }
    } catch {
      // first run, or unreadable: the defaults
    }
  }

  get current(): Settings {
    return structuredClone(this.data)
  }

  update(patch: Partial<Settings>): Settings {
    this.data = { ...this.data, ...patch, hotkeys: { ...this.data.hotkeys, ...patch.hotkeys } }
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2))
      renameSync(`${this.file}.tmp`, this.file)
    }
    return this.current
  }

  /** Why this shortcut can't be used for `name`, or null when it can (whether another app has it is checked on registering). */
  hotkeyProblem(name: HotkeyName, accelerator: unknown): string | null {
    if (!NAMES.includes(name)) return 'Unknown shortcut.'
    if (!isAccelerator(accelerator)) return 'Use Cmd/Ctrl or Alt with one other key.'
    const clash = NAMES.find((other) => other !== name && this.data.hotkeys[other].toLowerCase() === accelerator.toLowerCase())
    return clash ? 'Another Clueless shortcut already uses that.' : null
  }
}
