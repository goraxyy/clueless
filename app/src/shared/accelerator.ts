// Turning a key press into an Electron shortcut ("CommandOrControl+Shift+K") for the hotkey
// recorder in settings. Cmd on a Mac and Ctrl on Windows both become CommandOrControl, so a
// shortcut means the same thing on both.

export interface KeyPress {
  code: string // which physical key (KeyboardEvent.code), so Shift+2 stays "2", not "@"
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const PUNCTUATION: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`'
}

/** The key's name as Electron writes it, or null for keys a shortcut can't use (modifiers alone, Escape...). */
function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  if (code === 'Space') return 'Space'
  if (/^Arrow(Up|Down|Left|Right)$/.test(code)) return code.slice(5)
  return PUNCTUATION[code] ?? null
}

/** null until the press has a main modifier (Cmd/Ctrl or Alt) and a usable key. */
export function acceleratorFor(press: KeyPress, mac: boolean): string | null {
  const key = keyName(press.code)
  if (!key) return null
  const parts: string[] = []
  // Cmd on a Mac, Ctrl elsewhere: the app's usual modifier. Ctrl on a Mac is its own key.
  if (mac ? press.metaKey : press.ctrlKey) parts.push('CommandOrControl')
  if (mac && press.ctrlKey) parts.push('Control')
  if (press.altKey) parts.push('Alt')
  if (parts.length === 0) return null // Shift alone would take over ordinary typing
  if (press.shiftKey) parts.push('Shift')
  return [...parts, key].join('+')
}
