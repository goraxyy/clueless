// The floating overlay panel, the island's windows and the full-screen "select an area" window.
import { app, BrowserWindow, screen, shell, type Display } from 'electron'
import { join } from 'node:path'
import type { CodeSpot, Rect, WindowMode } from '../../shared/contracts'
import { placeCard } from '../../shared/layout'

/** The window wraps the panel (plus an 8px margin for its shadow) and follows its height. */
export const PANEL_WIDTH = 416
/** Explain mode ('wide'): the animation pane sits next to the conversation. */
export const WIDE_WIDTH = 860
/** Compact ('compact'): just the small bar (logo, a box to type in, mic, voice, expand, settings), plus the margin. */
export const PILL_WIDTH = 348 + 16
const MIN_WIDTH = 320
const MAX_WIDTH = 960
const MARGIN = 16

// macOS: a 'panel' window floats over full-screen apps and appears on every Space, and it takes
// keyboard focus without activating the app, so a full-screen browser isn't switched away from.
const PANEL_TYPE = process.platform === 'darwin' ? { type: 'panel' } : {}

const webPreferences = {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
}

export function loadRenderer(win: BrowserWindow, hash = ''): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(hash ? `${devUrl}#${hash}` : devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}

export function createOverlay(): BrowserWindow {
  const work = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 180, // the panel reports its real height right after it renders
    x: work.x + work.width - PANEL_WIDTH - 16,
    y: work.y + 16,
    title: 'Clueless',
    show: false,
    frame: false,
    transparent: true, // transparent windows can't be resized natively: the panel's own grips resize it
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    ...PANEL_TYPE,
    webPreferences
  })
  // 'screen-saver' keeps it above full-screen windows (and above browsers in F11 on Windows).
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  // Don't call win.setContentProtection(true): it hides the window from screen sharing, and
  // Clueless should stay visible.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRenderer(win)
  return win
}

/** Make the window exactly as tall as the panel, keeping it on screen. */
export function fitPanelHeight(win: BrowserWindow, panelHeight: number): void {
  if (!Number.isFinite(panelHeight)) return
  const [x, y] = win.getPosition()
  const work = screen.getDisplayNearestPoint({ x, y }).workArea
  const height = Math.max(48, Math.min(Math.round(panelHeight) + MARGIN, work.height - 16))
  const [width, current] = win.getSize()
  if (Math.abs(current - height) < 2) return
  const top = Math.max(work.y, Math.min(y, work.y + work.height - height)) // grow downward, never off-screen
  win.setBounds({ x, y: top, width, height })
}

/** The student dragged a side edge. `anchor` is the edge that stays put; the window stays on screen. */
export function resizePanelWidth(win: BrowserWindow, width: number, anchor: 'left' | 'right', min = MIN_WIDTH): void {
  if (!Number.isFinite(width)) return
  const b = win.getBounds()
  const work = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
  const w = Math.round(Math.max(min, Math.min(width, MAX_WIDTH, work.width - 16)))
  if (w === b.width) return
  const x = anchor === 'right' ? b.x + b.width - w : b.x
  win.setBounds({ x: Math.max(work.x, Math.min(x, work.x + work.width - w)), y: b.y, width: w, height: b.height })
}

/** The student's own width, kept while the panel is wide or a pill, and given back after. */
const widthBefore = new WeakMap<BrowserWindow, number>()

/**
 * 'wide' widens the panel to the left for the animation pane; 'compact' shrinks it to the pill
 * (keeping its right edge); 'expanded' gives the student's width back. The height keeps
 * following the panel.
 */
export function setPanelMode(win: BrowserWindow, mode: WindowMode): void {
  const { width } = win.getBounds()
  if (mode === 'wide') {
    if (!widthBefore.has(win) && width < WIDE_WIDTH) widthBefore.set(win, width)
    resizePanelWidth(win, Math.max(width, WIDE_WIDTH), 'right')
  } else if (mode === 'compact') {
    if (!widthBefore.has(win)) widthBefore.set(win, width)
    resizePanelWidth(win, PILL_WIDTH, 'right', PILL_WIDTH)
  } else if (widthBefore.has(win)) {
    resizePanelWidth(win, widthBefore.get(win) ?? PANEL_WIDTH, 'right')
    widthBefore.delete(win)
  }
}

// ---------- code-mode animation ----------

/** A see-through, click-through layer over `display` that draws animations on the student's code. */
export function createStage(display: Display): BrowserWindow {
  const win = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false, // never steals focus from the student's editor or the panel
    enableLargerThanScreen: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    ...PANEL_TYPE,
    webPreferences
  })
  win.setIgnoreMouseEvents(true) // clicks go through to the code (and the panel) underneath
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  loadRenderer(win, 'stage')
  return win
}

// ---------- area selection ----------

let finishSelection: ((rect: Rect | null) => void) | null = null

/** Show a dimmed full-screen layer on `display` and let the student drag a box. */
export function selectArea(display: Display): Promise<Rect | null> {
  finishSelection?.(null)
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      ...PANEL_TYPE,
      webPreferences
    })
    win.setAlwaysOnTop(true, 'screen-saver', 1) // one level above the panel
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })

    const done = (rect: Rect | null): void => {
      if (finishSelection !== done) return
      finishSelection = null
      if (!win.isDestroyed()) win.close()
      resolve(rect)
    }
    finishSelection = done
    win.on('closed', () => done(null))
    win.once('ready-to-show', () => {
      win.setBounds(display.bounds) // macOS may nudge it below the menu bar on creation
      win.show()
      win.focus()
    })
    loadRenderer(win, 'select')
  })
}

export function resolveAreaSelection(rect: Rect | null): void {
  finishSelection?.(rect)
}

// ---------- the island ----------

/** The island: a see-through window with the pill, at the top center of the screen. It shows
 *  without taking focus, so the app the student is in (and their highlight) stays active. */
export function createIsland(): BrowserWindow {
  const win = new BrowserWindow({
    width: 320,
    height: 64,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    title: 'Clueless',
    ...PANEL_TYPE,
    webPreferences
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  // Never call win.setContentProtection(true): Clueless stays visible on screen share by design.
  loadRenderer(win, 'island')
  return win
}

/** `size` is the pill as measured by its page, centered at the top of the display. */
export function placeIsland(win: BrowserWindow, display: Display, size: { width: number; height: number }): void {
  const work = display.workArea
  const width = Math.min(Math.ceil(size.width), work.width)
  const height = Math.min(Math.ceil(size.height), work.height - 16)
  win.setBounds({ x: Math.round(work.x + (work.width - width) / 2), y: work.y + 6, width, height })
}

export const ASK_BUTTON_SIZE = { width: 208, height: 48 }

/** The little Ask / Animate buttons that appear next to the cursor after a highlight. Never take focus. */
export function createAskButton(): BrowserWindow {
  const win = new BrowserWindow({
    ...ASK_BUTTON_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    ...PANEL_TYPE,
    webPreferences
  })
  win.setAlwaysOnTop(true, 'screen-saver', 2) // above the island
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  loadRenderer(win, 'ask')
  return win
}

/** Just below and right of where the mouse was released, kept on screen. */
export function placeAskButton(win: BrowserWindow, at: { x: number; y: number }, display: Display): void {
  const work = display.workArea
  const { width, height } = ASK_BUTTON_SIZE
  const x = Math.max(work.x, Math.min(at.x + 6, work.x + work.width - width))
  const y = Math.max(work.y, Math.min(at.y + 12, work.y + work.height - height))
  win.setBounds({ x, y, width, height })
}

// ---------- the visual island ----------

/** The visual island: the animation's own small window (the picture, what's being said, and the
 *  controls), beside the student's code. Shows without taking focus; drag it by its top bar. */
export function createVisualIsland(): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 320,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true, // the first click on a control works without focusing the window first
    backgroundColor: '#00000000',
    title: 'Clueless animation',
    ...PANEL_TYPE,
    webPreferences
  })
  win.setAlwaysOnTop(true, 'screen-saver', 1) // above the highlight drawn on the code
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  loadRenderer(win, 'visual')
  return win
}

/**
 * Beside the highlighted code (right, left, below or above, whichever fits), out from under the
 * panel (`avoid`, display-local). No spot: the right side of the screen, a little below the top.
 */
export function placeVisualIsland(
  win: BrowserWindow,
  display: Display,
  size: { width: number; height: number },
  spot: CodeSpot | null,
  avoid: Rect | null
): void {
  const { bounds, workArea } = display
  const width = Math.min(Math.ceil(size.width), workArea.width - 16)
  const height = Math.min(Math.ceil(size.height), workArea.height - 16)
  let x = workArea.x + workArea.width - width - 24
  let y = workArea.y + Math.round(workArea.height / 5)
  if (spot) {
    const area = spot.lineHeight > 0 ? { x: spot.left, y: spot.top, width: spot.width, height: spot.lines * spot.lineHeight } : { x: spot.left, y: spot.top, width: 1, height: 1 }
    const { card } = placeCard(area, { width, height }, bounds, avoid, area.y + area.height / 2)
    x = bounds.x + card.x
    y = bounds.y + card.y
  }
  win.setBounds(keepOnScreen({ x, y, width, height }, workArea))
}

/** The visual island measured itself: keep its top-left corner, and keep it on screen. */
export function resizeVisualIsland(win: BrowserWindow, size: { width: number; height: number }): void {
  const b = win.getBounds()
  const work = screen.getDisplayMatching(b).workArea
  const width = Math.min(Math.ceil(size.width), work.width - 16)
  const height = Math.min(Math.ceil(size.height), work.height - 16)
  if (width === b.width && height === b.height) return
  win.setBounds(keepOnScreen({ x: b.x, y: b.y, width, height }, work))
}

function keepOnScreen(r: Rect, work: Rect): Rect {
  return {
    x: Math.round(Math.max(work.x + 8, Math.min(r.x, work.x + work.width - r.width - 8))),
    y: Math.round(Math.max(work.y + 8, Math.min(r.y, work.y + work.height - r.height - 8))),
    width: r.width,
    height: r.height
  }
}
