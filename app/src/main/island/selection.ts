// Notices when the student finishes highlighting text in any app, and reads what they highlighted.
// Runs only while the island is showing. Apps don't share their selection, so on a select gesture
// we press the copy shortcut for the student, read the clipboard, and put their clipboard back.
import { clipboard, ClipboardItem, screen, type ClipboardBookmark } from 'electron'
import { uIOhook, UiohookKey, type UiohookMouseEvent } from 'uiohook-napi'
import { isSelectGesture, type Press } from './gesture'

export interface Point {
  x: number
  y: number
}

export interface SelectionHandlers {
  /** True when the point (DIP) is on one of Clueless's own windows: those clicks are ignored. */
  isOwnWindowAt(p: Point): boolean
  /** Highlighting is off right now (the pill's switch). */
  paused(): boolean
  /** Text was highlighted: `at` is where the mouse was released, `from` where the drag started (DIP). */
  onSelection(text: string, at: Point, from: Point): void
  /** The mouse wheel turned, or Page Up / Page Down: what's on screen moved. */
  onScroll(): void
  /** Any other click or key press: the Ask button should go away. */
  onOtherInput(at: Point | null): void
}

const LEFT_BUTTON = 1

/** Cmd+C on a Mac. On Windows, Ctrl+Insert: it copies in nearly every app, and in a terminal with
 *  nothing selected it does nothing, where Ctrl+C would stop the program that's running. */
const COPY_KEYS = {
  darwin: [UiohookKey.C, UiohookKey.Meta],
  other: [UiohookKey.Insert, UiohookKey.Ctrl]
} as const
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class SelectionWatcher {
  private listening = false
  private running = false
  private down: Press | null = null
  private downAt: Point | null = null
  private probing = false

  constructor(private readonly handlers: SelectionHandlers) {}

  start(): void {
    if (this.running) return
    if (!this.listening) {
      uIOhook.on('mousedown', (e) => this.onDown(e))
      uIOhook.on('mouseup', (e) => void this.onUp(e))
      uIOhook.on('keydown', (e) => {
        if (!this.running || this.probing) return
        this.handlers.onOtherInput(null)
        if (e.keycode === UiohookKey.PageUp || e.keycode === UiohookKey.PageDown) this.handlers.onScroll()
      })
      uIOhook.on('wheel', () => {
        // scrolling Clueless's own panel doesn't move the student's code
        if (this.running && !this.handlers.isOwnWindowAt(screen.getCursorScreenPoint())) this.handlers.onScroll()
      })
      this.listening = true
    }
    uIOhook.start()
    this.running = true
  }

  stop(): void {
    if (!this.running) return
    uIOhook.stop()
    this.running = false
    this.down = null
  }

  private onDown(e: UiohookMouseEvent): void {
    if (!this.running || this.probing) return
    const at = screen.getCursorScreenPoint()
    if (e.button !== LEFT_BUTTON || this.handlers.isOwnWindowAt(at)) {
      this.down = null
      return
    }
    this.down = { x: e.x, y: e.y }
    this.downAt = at
    this.handlers.onOtherInput(at)
  }

  private async onUp(e: UiohookMouseEvent): Promise<void> {
    if (!this.running || this.probing || e.button !== LEFT_BUTTON || this.handlers.paused()) return
    const down = this.down
    const downAt = this.downAt
    this.down = null
    const at = screen.getCursorScreenPoint()
    if (this.handlers.isOwnWindowAt(at)) return
    if (!isSelectGesture(down, { x: e.x, y: e.y, clicks: e.clicks })) return
    await sleep(60) // let the app finish updating its selection
    const text = await this.copySelection()
    // a double or triple click selects where it was clicked
    if (text) this.handlers.onSelection(text, at, e.clicks >= 2 || !downAt ? at : downAt)
  }

  /** Press the copy shortcut for the student, read what got copied, then restore their clipboard. */
  private async copySelection(): Promise<string | null> {
    this.probing = true
    const saved = await saveClipboard()
    const marker = `⁣clueless-${Date.now()}`
    try {
      await clipboard.writeText(marker)
      const [key, modifier] = COPY_KEYS[process.platform === 'darwin' ? 'darwin' : 'other']
      uIOhook.keyTap(key, [modifier])
      for (let i = 0; i < 12; i++) {
        await sleep(40)
        const text = await clipboard.readText()
        if (text !== marker) return text.trim() ? text : null
      }
      return null // nothing was selected (the copy didn't change the clipboard)
    } finally {
      await restoreClipboard(saved)
      await sleep(30) // swallow the key events our own copy shortcut produced
      this.probing = false
    }
  }
}

/** Copy everything on the clipboard (every format) so it can be put back exactly. */
async function saveClipboard(): Promise<ClipboardItem[]> {
  try {
    const items = await clipboard.read()
    return await Promise.all(
      items.map(async (item) => {
        const data: Record<string, string | Blob | ClipboardBookmark> = {}
        for (const type of item.types) {
          try {
            data[type] = await item.getType(type)
          } catch {
            // a format that can't be read back is skipped
          }
        }
        return new ClipboardItem(data)
      })
    )
  } catch {
    return []
  }
}

async function restoreClipboard(saved: ClipboardItem[]): Promise<void> {
  try {
    if (saved.length) await clipboard.write(saved)
    else clipboard.clear()
  } catch {
    clipboard.clear()
  }
}
