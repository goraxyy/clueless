import { describe, expect, it } from 'vitest'
import { acceleratorFor, type KeyPress } from './accelerator'

const press = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

describe('acceleratorFor', () => {
  it('turns Cmd on a Mac and Ctrl on Windows into the same shortcut', () => {
    expect(acceleratorFor(press('KeyK', { metaKey: true, shiftKey: true }), true)).toBe('CommandOrControl+Shift+K')
    expect(acceleratorFor(press('KeyK', { ctrlKey: true, shiftKey: true }), false)).toBe('CommandOrControl+Shift+K')
  })

  it('keeps the key, not the character Shift makes, and knows the special keys', () => {
    expect(acceleratorFor(press('Digit2', { metaKey: true, shiftKey: true }), true)).toBe('CommandOrControl+Shift+2')
    expect(acceleratorFor(press('Space', { altKey: true }), true)).toBe('Alt+Space')
    expect(acceleratorFor(press('Slash', { ctrlKey: true, metaKey: true }), true)).toBe('CommandOrControl+Control+/')
    expect(acceleratorFor(press('F5', { ctrlKey: true }), false)).toBe('CommandOrControl+F5')
  })

  it('waits for a real shortcut: no modifier, Shift alone, or a modifier pressed on its own', () => {
    expect(acceleratorFor(press('KeyA'), true)).toBeNull()
    expect(acceleratorFor(press('KeyA', { shiftKey: true }), true)).toBeNull()
    expect(acceleratorFor(press('MetaLeft', { metaKey: true }), true)).toBeNull()
    expect(acceleratorFor(press('Escape', { metaKey: true }), true)).toBeNull()
  })
})
