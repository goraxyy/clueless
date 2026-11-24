// Clueless main process: windows, hotkeys, screen capture and IPC.
// Two ways in:
//   - the tutor panel (the main app): Ctrl/Cmd+Shift+Space reads the screen, +2 selects an area, +1 voice
//   - the island (Ctrl/Cmd+Shift+3): highlight anything, click Ask or Animate. The answer shows in
//     the panel; Animate also plays it step by step in the visual island (its own window, with a
//     voice) while the line it's on lights up on the student's screen
import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
  shell,
  systemPreferences,
  type Display,
  type NativeImage,
  type Rectangle
} from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  IPC,
  ISLAND_IPC,
  type AppSettings,
  type AppStatus,
  type CodeSpot,
  type FlashcardInput,
  type PermissionKind,
  type PermissionsState,
  type IslandView,
  type InputKind,
  type Rect,
  type SessionView,
  type StepIntent,
  type Subject,
  type UserAction,
  type WindowMode,
  stepCount
} from '../shared/contracts'
import { IslandController, type IslandCapture } from '../shared/islandController'
import { lessonFromVisual, normalizeSnippet } from '../shared/trace'
import {
  activeDisplay,
  captureDisplay,
  cropToRect,
  grayThumbnail,
  screenAccess,
  toModelImage,
  windowTitles
} from './capture/capture'
import { Account, serverConfig } from './account/account'
import { fileBox } from './account/box'
import { loadEnvFiles } from './env'
import { SelectionWatcher, type Point } from './island/selection'
import { grayFromBitmap, spotFromSelection } from './island/spot'
import { Tracer } from './island/tracer'
import { PythonRunner, toCodeTrace } from './run/python'
import { MemoryStore } from './memory/store'
import { SessionController } from './session'
import { StuckDetector } from './stuck/detector'
import { createTransport, providerInfo, type Hosted } from './tutor/provider'
import { Tutor, type ImageInput } from './tutor/tutor'
import { VoiceManager, type SocketLike } from './voice/deepgram'
import { ElevenLabs } from './voice/elevenlabs'
import { keepUpdated } from './updates'
import { createTray } from './windows/tray'
import {
  createAskButton,
  createIsland,
  createMainWindow,
  createOverlay,
  createStage,
  createVisualIsland,
  fitPanelHeight,
  placeAskButton,
  placeIsland,
  placeVisualIsland,
  resizePanelWidth,
  resizeVisualIsland,
  resolveAreaSelection,
  selectArea,
  setPanelMode
} from './windows/windows'

const HOTKEYS = { ask: 'CommandOrControl+Shift+Space', area: 'CommandOrControl+Shift+2' }
const VOICE_HOTKEY = 'CommandOrControl+Shift+1'
const ISLAND_HOTKEY = 'CommandOrControl+Shift+3'
const ASK_BUTTON_MS = 4000
const SMOKE = process.env.CLUELESS_SMOKE === '1'

let overlay: BrowserWindow | null = null
let stage: BrowserWindow | null = null // code-mode animations, drawn over the student's code
let stageLoaded = false
let island: BrowserWindow | null = null
let askButton: BrowserWindow | null = null
let visual: BrowserWindow | null = null // the visual island: an Animate run's picture, voice and controls
let visualSize = { width: 460, height: 320 } // what the visual island measured itself at
/** none = hidden · guess = placed before it measured itself · fixed = placed (or dragged) for good */
let visualPlaced: 'none' | 'guess' | 'fixed' = 'none'
let islandDisplay: Display
let pillSize = { width: 320, height: 64 } // what the pill measured itself at
let islandView: IslandView | null = null // the latest, for the stage
let askOnHighlight = true
/** The latest highlight: its text and where the drag started and ended (DIP). */
let pendingSelection: { text: string; from: Point; to: Point } | null = null
let askedSelection: { text: string; from: Point; to: Point } | null = null
let askTimer: NodeJS.Timeout | null = null
let capturing = false
const hotkeyErrors: string[] = []

const userEnvFile = (): string => join(app.getPath('userData'), '.env')
const log = (line: string): void => console.log(`[clueless] ${line}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const contains = (r: Rectangle, p: Point): boolean => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height

function loadKeys(): void {
  // Dev: app/.env. Installed app: the .env in the user data folder (shown in the UI).
  loadEnvFiles([join(process.cwd(), '.env'), join(app.getAppPath(), '.env'), userEnvFile()])
}

/** Signed in to Clueless, when this build has a server (set in setup()). */
let account: Account | null = null

/** The Clueless server, while signed in: Claude goes through it when there's no key in .env. */
function hosted(): Hosted | null {
  const a = account
  return a?.state().signedIn ? { baseURL: a.apiBase, token: () => a.token() } : null
}

/** A short-lived Deepgram token for one recording, from the Clueless server. */
async function fetchSttToken(server: Hosted): Promise<{ token: string } | { error: string }> {
  const token = await server.token()
  if (!token) return { error: 'Sign in to Clueless first.' }
  const res = await fetch(`${server.baseURL}/voice/stt-token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000)
  })
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: { message?: string } }
  return res.ok && body.token ? { token: body.token } : { error: body.error?.message ?? "Couldn't start talking. Try again." }
}

function status(): AppStatus {
  const ai = providerInfo(process.env, hosted())
  return {
    platform: process.platform,
    provider: ai?.provider ?? null,
    model: ai?.model ?? null,
    region: ai?.region ?? null,
    hasDeepgramKey: Boolean(process.env.DEEPGRAM_API_KEY) || Boolean(hosted()),
    screenAccess: screenAccess(),
    hotkeys: HOTKEYS,
    hotkeyErrors,
    envFile: app.isPackaged ? userEnvFile() : join(process.cwd(), '.env'),
    account: account?.state() ?? { configured: false, signedIn: false, email: null }
  }
}

/** To the panel, and to the main window while it's open. */
function toUi(channel: string, payload: unknown): void {
  for (const w of [overlay, mainWindow]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
}

// ---------- the main window ----------

let mainWindow: BrowserWindow | null = null

/**
 * Open (or bring forward) the main window. On macOS Clueless normally has no Dock icon, which is
 * what lets the panel float over full-screen apps; the Dock icon shows while the main window is
 * open and goes away when it closes.
 */
function openMain(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  if (process.platform === 'darwin') void app.dock?.show()
  mainWindow = createMainWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
    if (process.platform === 'darwin') {
      app.dock?.hide()
      // Hiding the Dock icon changes how macOS treats the app: re-join every Space, full-screen ones too.
      setTimeout(() => overlay?.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }), 300)
    }
  })
}

/** Read the screen from the main window. Clueless's own windows (this one included) are hidden
 *  while the screen is captured, so the problem behind it is what gets read. */
async function askFromMain(kind: 'screen' | 'area'): Promise<void> {
  await ask(kind)
}

// ---------- settings ----------

const settingsFile = (): string => join(app.getPath('userData'), 'clueless-settings.json')

function loadSettings(): AppSettings {
  let saved: Partial<AppSettings> = {}
  try {
    saved = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<AppSettings>
  } catch {
    // first run
  }
  return {
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    openMainOnLaunch: saved.openMainOnLaunch ?? true,
    setupDone: saved.setupDone ?? false
  }
}

function saveSettings(patch: unknown): AppSettings {
  const next = loadSettings()
  if (patch && typeof patch === 'object') {
    const p = patch as Partial<Record<keyof AppSettings, unknown>>
    if (typeof p.openMainOnLaunch === 'boolean') next.openMainOnLaunch = p.openMainOnLaunch
    if (typeof p.setupDone === 'boolean') next.setupDone = p.setupDone
    if (typeof p.openAtLogin === 'boolean' && app.isPackaged) {
      // Started at login: straight to the menu bar, no main window.
      app.setLoginItemSettings({ openAtLogin: p.openAtLogin, args: ['--hidden'] })
      next.openAtLogin = p.openAtLogin
    }
  }
  writeFileSync(settingsFile(), JSON.stringify({ openMainOnLaunch: next.openMainOnLaunch, setupDone: next.setupDone }, null, 2))
  return next
}

// ---------- permissions ----------

function permissions(): PermissionsState {
  const mac = process.platform === 'darwin'
  const mic = mac ? systemPreferences.getMediaAccessStatus('microphone') : 'granted'
  return {
    screen: screenAccess(),
    microphone: mic === 'granted' || mic === 'denied' || mic === 'not-determined' || mic === 'restricted' ? mic : 'unknown',
    accessibility: mac ? systemPreferences.isTrustedAccessibilityClient(false) : true
  }
}

const PRIVACY_PANES: Record<PermissionKind, string> = {
  screen: 'Privacy_ScreenCapture',
  microphone: 'Privacy_Microphone',
  accessibility: 'Privacy_Accessibility'
}

/** Ask macOS for a permission. The first time it shows its own prompt; after a "no" it can only be
 *  turned on in System Settings, so that page opens. */
async function requestPermission(kind: unknown): Promise<PermissionsState> {
  if (process.platform !== 'darwin' || (kind !== 'screen' && kind !== 'microphone' && kind !== 'accessibility')) return permissions()
  const now = permissions()
  if (kind === 'microphone' && now.microphone === 'not-determined') {
    await systemPreferences.askForMediaAccess('microphone')
  } else if (kind === 'accessibility' && !now.accessibility) {
    systemPreferences.isTrustedAccessibilityClient(true) // macOS's prompt, with a button to the settings
  } else if (kind === 'screen' && now.screen === 'not-determined') {
    // Asking to capture is what makes macOS list (and prompt for) Clueless.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => [])
  } else {
    void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES[kind]}`)
  }
  return permissions()
}

function makeTutor(): Tutor | null {
  const transport = createTransport(process.env, 'tutor', hosted()) // keys in .env, or the Clueless server
  return transport ? new Tutor(transport, log) : null
}

function showOverlay(): void {
  if (!overlay) return
  // No app.focus() here: on macOS the panel takes keyboard focus without activating the app,
  // so a full-screen browser stays in its own Space instead of being switched away from.
  overlay.show()
  overlay.focus()
}

function toggleOverlay(): void {
  if (overlay?.isVisible()) overlay.hide()
  else showOverlay()
}

/** Clueless's own windows that are on screen right now. */
function ownVisibleWindows(): BrowserWindow[] {
  // The main window too: it would otherwise be what gets read.
  return [overlay, stage, island, askButton, visual, mainWindow].filter((w): w is BrowserWindow => Boolean(w && !w.isDestroyed() && w.isVisible()))
}

/** Hide Clueless's own windows (without losing their place) while the screen is captured. */
async function withPanelHidden<T>(fn: () => Promise<T>): Promise<T> {
  const own = ownVisibleWindows()
  if (own.length) {
    own.forEach((w) => w.setOpacity(0))
    await sleep(150)
  }
  try {
    return await fn()
  } finally {
    own.forEach((w) => !w.isDestroyed() && w.setOpacity(1))
  }
}

/** Let the student drag a box on the display under the mouse, then capture that display.
 *  null = cancelled; `full` is null if the capture failed. */
async function pickArea(): Promise<{ full: NativeImage | null; rect: Rect; display: Display } | null> {
  const display = activeDisplay()
  const own = ownVisibleWindows()
  own.forEach((w) => w.setOpacity(0))
  try {
    const rect: Rect | null = await selectArea(display)
    if (!rect || rect.width < 8 || rect.height < 8) return null
    await sleep(200) // let the selection layer disappear before capturing
    return { full: await captureDisplay(display), rect, display }
  } finally {
    own.forEach((w) => !w.isDestroyed() && w.setOpacity(1))
  }
}

// ---------- the stage: an Animate run's highlight on the code ----------

function displayById(id: number): Display {
  return screen.getAllDisplays().find((d) => d.id === id) ?? activeDisplay()
}

/** Where the panel is on `display`, so drawings don't land under it. */
function panelOn(display: Display): Rect | null {
  const panel = overlay?.isVisible() ? overlay.getBounds() : null
  return panel && { x: panel.x - display.bounds.x, y: panel.y - display.bounds.y, width: panel.width, height: panel.height }
}

/** Where the visual island is on `display` (display-local), for the arrow from the code to it. */
function visualOn(display: Display): Rect | null {
  const b = visual && !visual.isDestroyed() && visual.isVisible() ? visual.getBounds() : null
  return b && { x: b.x - display.bounds.x, y: b.y - display.bounds.y, width: b.width, height: b.height }
}

function sendStage(): void {
  if (!stage || stage.isDestroyed() || !stageLoaded) return
  const display = islandView?.spot ? displayById(islandView.spot.displayId) : null
  stage.webContents.send(IPC.stageIsland, { view: islandView, island: display ? visualOn(display) : null })
}

/** The stage is up while an Animate run highlights the code. */
function updateStage(): void {
  const islandDrawing = Boolean(islandView?.playback && islandView.spot && !islandView.spotLost && stepCount(islandView))
  const display = islandDrawing ? displayById(islandView!.spot!.displayId) : null
  if (!display) {
    sendStage()
    if (stage && !stage.isDestroyed()) stage.hide()
    return
  }
  if (!stage || stage.isDestroyed()) {
    const win = createStage(display)
    stage = win
    stageLoaded = false
    win.webContents.once('did-finish-load', () => {
      stageLoaded = true
      sendStage()
    })
    win.on('closed', () => {
      if (stage === win) stage = null
    })
  }
  stage.setBounds(display.bounds)
  sendStage()
  if (!SMOKE && !stage.isVisible()) stage.showInactive()
}

async function captureScreen(): Promise<ImageInput | null> {
  return withPanelHidden(async () => {
    const image = await captureDisplay(activeDisplay())
    return image ? toModelImage(image) : null
  })
}

async function ask(kind: 'screen' | 'area'): Promise<void> {
  if (capturing) return
  capturing = true
  try {
    loadKeys() // pick up a key added since launch
    toUi(IPC.status, status())
    if (screenAccess() === 'denied') {
      showOverlay()
      controller.fail('Clueless needs screen access to read your problem. Use the button above to allow it.')
      return
    }
    let image: ImageInput | null = null
    if (kind === 'area') {
      const picked = await pickArea()
      if (!picked) return
      image = picked.full ? toModelImage(cropToRect(picked.full, picked.rect, picked.display)) : null
    } else {
      image = await captureScreen()
    }
    showOverlay()
    if (!image) {
      controller.fail("Couldn't capture your screen. On macOS, allow Screen Recording for Clueless and restart it.")
      return
    }
    await controller.startProblem({ image })
  } finally {
    capturing = false
  }
}

/** A question typed before any problem: it starts one, with the screen for context. */
async function askWithText(text: string): Promise<void> {
  if (capturing) return
  capturing = true
  try {
    loadKeys() // pick up a key added since launch
    toUi(IPC.status, status())
    const image = await screenNow()
    await controller.startProblem(image ? { text, image } : { text })
  } finally {
    capturing = false
  }
}

/** The screen right now (Clueless hidden), or null without screen access. */
async function screenNow(): Promise<ImageInput | null> {
  if (screenAccess() === 'denied') return null
  try {
    return await captureScreen()
  } catch (err) {
    log(`capture failed: ${(err as Error).message}`)
    return null
  }
}

function openScreenSettings(): void {
  if (process.platform === 'darwin') {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  }
}

// ---------- the island: highlight -> Ask or Animate -> text, and the step-by-step animation ----------

let runner: PythonRunner | null = null

/** Runs Python highlights (Pyodide). Unpacked from the asar in the built app, since it reads its own files. */
function pythonRunner(): PythonRunner {
  runner ??= new PythonRunner(join(app.getAppPath(), 'node_modules', 'pyodide').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`))
  return runner
}

const islandController = new IslandController({
  makeTracer: () => {
    loadKeys() // pick up a key added since launch
    const tutor = createTransport(process.env, 'tutor', hosted())
    const fast = createTransport(process.env, 'fast', hosted())
    return tutor && fast ? new Tracer({ tutor, fast }, pythonRunner(), log) : null
  },
  capture: captureForIsland,
  screen: async () => {
    if (screenAccess() === 'denied') return null
    try {
      return await withPanelHidden(async () => {
        const image = await captureDisplay(islandDisplay)
        return image ? toModelImage(image) : null
      })
    } catch {
      return null
    }
  },
  emit: (view) => {
    const asked = view.phase !== 'idle' && (islandView?.phase ?? 'idle') === 'idle'
    islandView = view
    for (const w of [island, overlay, visual]) if (w && !w.isDestroyed()) w.webContents.send(ISLAND_IPC.view, view)
    // The answer shows in the panel: bring it up, without taking focus from the student's app.
    if (asked && overlay && !overlay.isVisible()) overlay.showInactive()
    updateVisual()
    updateStage()
  },
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  },
  now: () => Date.now()
})

function placePill(): void {
  if (island && !island.isDestroyed()) placeIsland(island, islandDisplay, pillSize)
}

/** The visual island is up while an Animate run's animation is: placed beside the code once, then
 *  it stays where it is (or where the student dragged it). */
function updateVisual(): void {
  if (!visual || visual.isDestroyed()) return
  const view = islandView
  if (!view?.playback || !stepCount(view)) {
    visualPlaced = 'none'
    if (visual.isVisible()) visual.hide()
    return
  }
  if (visualPlaced === 'none') {
    placeVisual()
    visualPlaced = 'guess'
  }
  if (!SMOKE && !visual.isVisible()) visual.showInactive() // the student's app keeps the focus
}

function placeVisual(): void {
  if (!visual || visual.isDestroyed()) return
  const spot = islandView?.spot ?? null
  const display = spot ? displayById(spot.displayId) : islandDisplay
  placeVisualIsland(visual, display, visualSize, spot, panelOn(display))
}

/** A screenshot of the display the student is working on (Clueless's own windows hidden), and
 *  where the highlighted lines are on it. */
async function captureForIsland(snippet: string): Promise<IslandCapture> {
  const selection = askedSelection
  const display = islandDisplay
  try {
    return await withPanelHidden(async () => {
      const image = await captureDisplay(display)
      const spot = selection ? findSpot(selection, snippet, display, image) : null
      return { image: image ? toModelImage(image) : null, spot }
    })
  } catch (err) {
    log(`capture failed: ${(err as Error).message}`)
    return { image: null, spot: null }
  }
}

function findSpot(selection: { from: Point; to: Point }, snippet: string, display: Display, image: NativeImage | null): CodeSpot {
  const local = (p: Point): Point => ({ x: p.x - display.bounds.x, y: p.y - display.bounds.y })
  const from = local(selection.from)
  const to = local(selection.to)
  const lines = normalizeSnippet(snippet).split('\n').length
  let gray = null
  if (image && !image.isEmpty()) {
    // Just the screen around the highlight, at one pixel per DIP.
    const scale = image.getSize().width / display.bounds.width
    const x0 = Math.max(0, Math.min(from.x, to.x) - 500)
    const x1 = Math.min(display.bounds.width, Math.max(from.x, to.x) + 700)
    const y0 = Math.max(0, Math.min(from.y, to.y) - 80)
    const y1 = Math.min(display.bounds.height, Math.max(from.y, to.y) + 80)
    if (x1 > x0 && y1 > y0) {
      const crop = image.crop({ x: Math.round(x0 * scale), y: Math.round(y0 * scale), width: Math.round((x1 - x0) * scale), height: Math.round((y1 - y0) * scale) })
      const size = crop.getSize()
      gray = grayFromBitmap(crop.toBitmap(), size.width, size.height, scale, x0, y0)
    }
  }
  const spot = spotFromSelection(from, to, lines, display.id, gray)
  log(`spot: ${lines} lines, top ${spot.top}, line ${spot.lineHeight.toFixed(1)}px, x ${spot.left}..${spot.left + spot.width}`)
  return spot
}

const watcher = new SelectionWatcher({
  isOwnWindowAt: (p) =>
    [overlay, island, askButton, visual].some((w) => w && !w.isDestroyed() && w.isVisible() && contains(w.getBounds(), p)),
  paused: () => !askOnHighlight,
  onSelection: (text, at, from) => {
    pendingSelection = { text, from, to: at }
    showAskButton(at)
  },
  onScroll: () => islandController.scrolled(),
  onOtherInput: (at) => {
    if (!askButton?.isVisible()) return
    if (!at || !contains(askButton.getBounds(), at)) hideAskButton()
  }
})

function showAskButton(at: Point): void {
  if (!askButton || askButton.isDestroyed()) return
  placeAskButton(askButton, at, screen.getDisplayNearestPoint(at))
  askButton.showInactive()
  armAskTimer()
}

/** The button goes away after a few seconds, unless the mouse is on it. */
function armAskTimer(): void {
  if (askTimer) clearTimeout(askTimer)
  askTimer = setTimeout(() => {
    if (askButton?.isVisible() && contains(askButton.getBounds(), screen.getCursorScreenPoint())) armAskTimer()
    else hideAskButton()
  }, ASK_BUTTON_MS)
}

function hideAskButton(): void {
  if (askTimer) clearTimeout(askTimer)
  askTimer = null
  if (askButton && !askButton.isDestroyed()) askButton.hide()
}

/** Ask (explain it) or Animate (explain it with an animation and a voice) was clicked next to a highlight. */
function onIslandAsk(animate: boolean): void {
  const selection = pendingSelection
  const at = askButton?.getBounds()
  hideAskButton()
  if (!selection) return
  if (at) islandDisplay = screen.getDisplayMatching(at)
  askedSelection = selection
  void islandController.ask(selection.text, animate)
}

function showIsland(): void {
  if (!island) return
  islandDisplay = activeDisplay()
  placePill()
  island.showInactive() // keep the student's app (and its highlight) focused
}

/** Highlights are watched from launch, pill or not (the Highlight switch turns the buttons off). */
function watchHighlights(): void {
  try {
    watcher.start()
  } catch (err) {
    log(`can't watch for highlights: ${(err as Error).message}`)
  }
}

function hideIsland(): void {
  hideAskButton()
  islandController.close()
  island?.hide()
}

function toggleIsland(): void {
  if (island?.isVisible()) hideIsland()
  else showIsland()
}

/** The tutor's reply to Animate plays in the visual island as soon as it arrives (once per turn). */
let lastAnimatedTurn: string | null = null
function playTutorAnimation(view: SessionView | null): void {
  const item = view?.thread.at(-1)
  if (!item || item.role !== 'tutor' || item.id === lastAnimatedTurn) return
  const { visual: v, animation, message } = item.turn
  if (!animation || !v?.frames.length) return
  lastAnimatedTurn = item.id
  if (overlay && !overlay.isDestroyed()) islandDisplay = screen.getDisplayMatching(overlay.getBounds())
  islandController.playLesson(lessonFromVisual(v, message))
}

// ---------- wiring ----------

let controller: SessionController
let stuck: StuckDetector
let voice: VoiceManager
const keepAlive: unknown[] = [] // the tray icon disappears if it's garbage-collected

function setup(): void {
  loadKeys()
  if (process.platform === 'darwin') {
    // An overlay, not a regular app: no dock icon (the menu-bar icon replaces it). Together with
    // the panel window type this lets Clueless float over full-screen apps without macOS
    // switching Spaces.
    app.dock?.hide()
  }
  // Copy, paste, select all and undo in the text boxes come from the app menu's Edit roles.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      process.platform === 'darwin' ? [{ role: 'appMenu' }, { role: 'editMenu' }] : [{ role: 'editMenu' }]
    )
  )
  const store = new MemoryStore(join(app.getPath('userData'), 'clueless-memory.json'), () => toUi(IPC.memoryChanged, null))

  // The main window: history, flashcards, setup and settings.
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 200 ? v : null)
  ipcMain.on(IPC.openMain, () => openMain())
  ipcMain.on(IPC.showPanel, () => showOverlay())
  ipcMain.on(IPC.askFromMain, (_e, mode: unknown) => void askFromMain(mode === 'area' ? 'area' : 'screen'))
  ipcMain.handle(IPC.historyList, () => store.sessions())
  ipcMain.handle(IPC.historyGet, (_e, id: unknown) => (str(id) ? store.session(str(id)!) : null))
  ipcMain.handle(IPC.historyDelete, (_e, id: unknown) => {
    if (str(id)) store.deleteSession(str(id)!)
  })
  ipcMain.handle(IPC.cardsList, () => store.cards())
  ipcMain.handle(IPC.cardsAdd, (_e, card: unknown) => (card && typeof card === 'object' ? store.addCard(card as FlashcardInput) : null))
  ipcMain.handle(IPC.cardsUpdate, (_e, arg: { id?: unknown; patch?: unknown }) => {
    if (str(arg?.id) && arg.patch && typeof arg.patch === 'object') store.updateCard(str(arg.id)!, arg.patch as Record<string, unknown>)
  })
  ipcMain.handle(IPC.cardsDelete, (_e, id: unknown) => {
    if (str(id)) store.deleteCard(str(id)!)
  })
  ipcMain.handle(IPC.cardsReview, (_e, arg: { id?: unknown; knew?: unknown }) => {
    if (str(arg?.id) && typeof arg.knew === 'boolean') store.reviewCard(str(arg.id)!, arg.knew)
  })
  ipcMain.handle(IPC.permissions, () => permissions())
  ipcMain.handle(IPC.requestPermission, (_e, kind: unknown) => requestPermission(kind))
  ipcMain.handle(IPC.getSettings, () => loadSettings())
  ipcMain.handle(IPC.setSettings, (_e, patch: unknown) => saveSettings(patch))
  ipcMain.on(IPC.openExternal, (_e, url: unknown) => {
    if (typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url) && url.length < 2000) void shell.openExternal(url)
  })

  // The server is set in the env (CLUELESS_SUPABASE_URL / _KEY) or baked in at build time from
  // MAIN_VITE_SUPABASE_URL / MAIN_VITE_SUPABASE_KEY in app/.env.
  const server = serverConfig(process.env, { url: import.meta.env.MAIN_VITE_SUPABASE_URL, key: import.meta.env.MAIN_VITE_SUPABASE_KEY })
  if (server) {
    account = new Account(server, fileBox(join(app.getPath('userData'), 'clueless-account.bin')), () => toUi(IPC.status, status()))
    void account.whenReady().then(() => toUi(IPC.status, status()))
  }
  const noServer = { ok: false as const, message: 'This build of Clueless has no server to sign in to.' }
  ipcMain.handle(IPC.accountSendCode, (_e, email: unknown) => account?.sendCode(email) ?? noServer)
  ipcMain.handle(IPC.accountVerify, (_e, arg: { email?: unknown; code?: unknown }) => account?.verifyCode(arg?.email, arg?.code) ?? noServer)
  ipcMain.handle(IPC.accountSignOut, () => account?.signOut())
  ipcMain.handle(IPC.accountUsage, () => account?.usage() ?? null)

  stuck = new StuckDetector({
    thumbnail: () => grayThumbnail(activeDisplay()),
    windowTitles,
    isCluelessFocused: () => Boolean(overlay?.isFocused()),
    onChange: (state) => controller.setStuck(state)
  })

  controller = new SessionController({
    makeTutor,
    memory: store,
    captureScreen,
    emit: (view: SessionView | null) => {
      toUi(IPC.session, view)
      playTutorAnimation(view)
    },
    stuck
  })

  voice = new VoiceManager({
    apiKey: () => {
      loadKeys() // pick up a key added since launch
      return process.env.DEEPGRAM_API_KEY?.trim() || undefined
    },
    serverToken: () => {
      const server = hosted()
      return server ? fetchSttToken(server) : null
    },
    events: {
      transcript: (t) => toUi(IPC.voiceTranscript, t),
      state: (e) => toUi(IPC.voiceState, e)
    },
    // Node's built-in WebSocket (no extra package).
    makeSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike
  })

  ipcMain.handle(IPC.getStatus, () => status())
  ipcMain.handle(IPC.getSession, () => controller.current)
  ipcMain.handle(IPC.getMemory, () => store.view())
  ipcMain.on(IPC.ask, (_e, mode: 'screen' | 'area') => void ask(mode === 'area' ? 'area' : 'screen'))
  ipcMain.on(IPC.askText, (e, text: string) => {
    if (typeof text !== 'string' || !text.trim()) return
    // Typed in the main window: the screen would only show Clueless, so the text goes alone.
    if (mainWindow && e.sender === mainWindow.webContents) return void controller.startProblem({ text: text.slice(0, 8000) })
    void askWithText(text.slice(0, 8000))
  })
  ipcMain.on(IPC.send, (e, arg: { text: string; as: InputKind }) => {
    if (typeof arg?.text !== 'string') return
    // From the main window the screen would just show Clueless itself: send the text alone.
    if (mainWindow && e.sender === mainWindow.webContents) return void controller.send(arg.text.slice(0, 4000), arg.as, null)
    // A typed message can be about anything on screen, so the screen goes with it.
    void screenNow().then((image) => controller.send(arg.text.slice(0, 4000), arg.as, image))
  })
  ipcMain.on(IPC.action, (_e, action: UserAction) => void controller.action(action))
  ipcMain.on(IPC.step, (_e, arg: { id: number; intent: StepIntent }) => {
    if (typeof arg?.id === 'number' && ['stuck', 'revisit', 'claim'].includes(arg.intent)) void controller.step(arg.id, arg.intent)
  })
  ipcMain.on(IPC.setSubject, (_e, subject: Subject) => controller.setSubject(subject))
  // Compact needs nothing here (the panel shrinks to its header and fitHeight follows it);
  // 'wide' makes room for the explain-mode animation pane.
  ipcMain.on(IPC.windowMode, (_e, mode: WindowMode) => {
    if (overlay && (mode === 'compact' || mode === 'expanded' || mode === 'wide')) setPanelMode(overlay, mode)
  })
  ipcMain.on(IPC.fitHeight, (_e, px: number) => {
    if (overlay && typeof px === 'number') fitPanelHeight(overlay, px)
  })
  ipcMain.on(IPC.resizeWidth, (_e, arg: { width: number; anchor: 'left' | 'right' }) => {
    if (overlay && typeof arg?.width === 'number') resizePanelWidth(overlay, arg.width, arg.anchor === 'left' ? 'left' : 'right')
  })
  ipcMain.on(IPC.hide, () => overlay?.hide())
  ipcMain.on(IPC.quit, () => app.quit())
  ipcMain.on(IPC.openScreenSettings, () => openScreenSettings())
  ipcMain.on(IPC.areaDone, (_e, rect: Rect) => resolveAreaSelection(rect))
  ipcMain.on(IPC.areaCancel, () => resolveAreaSelection(null))

  ipcMain.handle(ISLAND_IPC.getView, () => islandController.current)
  ipcMain.on(ISLAND_IPC.setAskOnHighlight, (_e, on: unknown) => {
    askOnHighlight = Boolean(on)
    if (!askOnHighlight) hideAskButton()
    islandController.setAskOnHighlight(askOnHighlight)
  })
  ipcMain.on(ISLAND_IPC.followUp, (_e, text: unknown) => {
    if (typeof text === 'string') void islandController.followUp(text.slice(0, 2000))
  })
  ipcMain.on(ISLAND_IPC.close, () => islandController.close())
  ipcMain.on(ISLAND_IPC.hide, () => hideIsland())
  ipcMain.on(ISLAND_IPC.ask, (_e, arg: { animate?: unknown }) => onIslandAsk(Boolean(arg?.animate)))
  ipcMain.on(ISLAND_IPC.play, () => islandController.play())
  ipcMain.on(ISLAND_IPC.pause, () => islandController.pause())
  ipcMain.on(ISLAND_IPC.step, (_e, delta: unknown) => {
    if (typeof delta === 'number') islandController.step(delta)
  })
  ipcMain.on(ISLAND_IPC.replay, () => islandController.replay())
  ipcMain.on(ISLAND_IPC.stop, () => islandController.stopPlayback())
  ipcMain.on(ISLAND_IPC.speed, (_e, speed: unknown) => {
    if (typeof speed === 'number') islandController.setSpeed(speed)
  })
  ipcMain.on(ISLAND_IPC.voice, (_e, on: unknown) => islandController.setVoice(Boolean(on)))
  ipcMain.on(ISLAND_IPC.stepDone, (_e, arg: { nonce?: unknown; index?: unknown }) => {
    if (typeof arg?.nonce === 'number' && typeof arg.index === 'number') islandController.stepDone(arg.nonce, arg.index)
  })
  ipcMain.on(ISLAND_IPC.narrated, (_e, on: unknown) => islandController.setNarrated(Boolean(on)))
  ipcMain.on(ISLAND_IPC.resize, (_e, size: { width: number; height: number }) => {
    if (!Number.isFinite(size?.width) || !Number.isFinite(size?.height) || size.width < 1 || size.height < 1) return
    pillSize = { width: size.width, height: size.height }
    placePill()
  })
  ipcMain.on(ISLAND_IPC.resizeVisual, (_e, size: { width: number; height: number }) => {
    if (!Number.isFinite(size?.width) || !Number.isFinite(size?.height) || size.width < 1 || size.height < 1) return
    visualSize = { width: size.width, height: size.height }
    if (!visual || visual.isDestroyed() || visualPlaced === 'none') return
    if (visualPlaced === 'guess') {
      placeVisual() // now that its real size is known
      visualPlaced = 'fixed'
    } else {
      resizeVisualIsland(visual, visualSize)
    }
    sendStage()
  })
  ipcMain.handle(IPC.voiceMicAccess, async () => {
    // macOS asks the student once; Windows uses its own privacy setting and Chromium handles it.
    if (process.platform !== 'darwin') return true
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return systemPreferences.askForMediaAccess('microphone')
  })
  const elevenLabs = new ElevenLabs(
    () => {
      loadKeys() // pick up a key added since launch
      return process.env
    },
    fetch,
    log,
    hosted
  )
  ipcMain.handle(IPC.voiceTts, (_e, req: unknown) => elevenLabs.speak(req))
  ipcMain.on(IPC.voiceStart, (_e, id: unknown) => voice.start(id))
  ipcMain.on(IPC.voiceAudio, (_e, arg: { id?: unknown; chunk?: unknown }) => voice.audio(arg?.id, arg?.chunk))
  ipcMain.on(IPC.voiceStop, (_e, id: unknown) => voice.stop(id))
  ipcMain.on(IPC.voiceCancel, (_e, id: unknown) => voice.cancel(id))

  overlay = createOverlay()
  overlay.on('closed', () => {
    voice.cancelAll()
    overlay = null
  })
  // A reload (or crash) of the UI drops its recorder: close the Deepgram side too.
  overlay.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) voice.cancelAll()
  })
  overlay.webContents.on('render-process-gone', () => voice.cancelAll())

  islandDisplay = activeDisplay()
  setTimeout(() => pythonRunner().warm(), 3000) // load Python in the background, so the first run is quick
  island = createIsland()
  island.on('closed', () => (island = null))
  askButton = createAskButton()
  visual = createVisualIsland()
  visual.on('closed', () => (visual = null))
  visual.on('will-move', () => (visualPlaced = 'fixed')) // the student dragged it: leave it there
  visual.on('move', () => sendStage()) // the arrow from the code follows it

  keepAlive.push(createTray({
    openMain,
    ask: () => void ask('screen'),
    selectArea: () => void ask('area'),
    toggle: toggleOverlay,
    toggleIsland,
    quit: () => app.quit(),
    hotkeys: { ...HOTKEYS, island: ISLAND_HOTKEY }
  }))

  if (SMOKE) {
    // `CLUELESS_SMOKE=1 npm start`: load the panel and the island hidden, check both rendered, run
    // a little Python in the worker, have the (hidden) stage and visual island draw that run, then quit.
    overlay.webContents.once('did-finish-load', async () => {
      await sleep(2500)
      const ready = 'Boolean(document.querySelector("[data-app-ready]"))'
      const panelOk = await overlay?.webContents.executeJavaScript(ready)
      const islandOk = await island?.webContents.executeJavaScript(ready)
      const code = 'x = 1\ny = x + 1'
      const run = await pythonRunner()
        .trace(code, { setup: '', call: '' })
        .catch((err: Error) => (log(`smoke: python failed: ${err.message}`), null))
      const trace = run ? toCodeTrace(run, code) : null
      const pythonOk = trace?.steps.length === 2
      islandView = {
        ...islandController.current,
        phase: 'answer',
        animate: true,
        trace,
        spot: { displayId: activeDisplay().id, left: 200, width: 300, top: 200, lineHeight: 22, lines: 2 },
        playback: { nonce: 1, index: 0, playing: false }
      }
      visual?.webContents.send(ISLAND_IPC.view, islandView)
      updateVisual()
      updateStage()
      await sleep(2000)
      const stageOk = await stage?.webContents.executeJavaScript('Boolean(document.querySelector("[data-trace-stage]"))')
      const visualOk = await visual?.webContents.executeJavaScript('Boolean(document.querySelector("[data-visual-island]"))')
      const parts = { panel: panelOk, island: islandOk, python: pythonOk, stage: stageOk, visual: visualOk }
      const ok = Object.values(parts).every(Boolean)
      const failed = Object.entries(parts).filter(([, v]) => !v).map(([k]) => k)
      console.log(ok ? 'SMOKE OK' : `SMOKE FAIL: ${failed.join(', ')} did not work`)
      runner?.dispose()
      app.exit(ok ? 0 : 1)
    })
    return
  }

  // Launching while a full-screen app is in front: the window is created before macOS has finished
  // turning Clueless into a menu-bar app, so it can land on the desktop Space only. Re-join every
  // Space (full-screen ones included) once that's settled, then show it the same way the hotkey does.
  overlay.once('ready-to-show', () =>
    setTimeout(() => {
      overlay?.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
      // Opened from Finder: the main window (first run: setup). Started at login, or the student
      // turned it off: just the panel, from the menu bar.
      const settings = loadSettings()
      const atLogin = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin
      if (!SMOKE && !atLogin && (settings.openMainOnLaunch || !settings.setupDone)) openMain()
      else showOverlay()
    }, 800)
  )
  for (const [name, accelerator] of Object.entries(HOTKEYS)) {
    const ok = globalShortcut.register(accelerator, () => void ask(name === 'area' ? 'area' : 'screen'))
    if (!ok) hotkeyErrors.push(`${accelerator} is taken by another app`)
  }
  const voiceOk = globalShortcut.register(VOICE_HOTKEY, () => {
    showOverlay()
    // The panel only: the main window must not start a recording of its own.
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send(IPC.voiceToggle, null)
  })
  if (!voiceOk) hotkeyErrors.push(`${VOICE_HOTKEY} is taken by another app`)
  if (!globalShortcut.register(ISLAND_HOTKEY, toggleIsland)) hotkeyErrors.push(`${ISLAND_HOTKEY} is taken by another app`)
  watchHighlights()
  if (!SMOKE) keepUpdated(log)
  log(`ready. Ask: ${HOTKEYS.ask}  Select area: ${HOTKEYS.area}  Voice: ${VOICE_HOTKEY}  Island: ${ISLAND_HOTKEY}`)
}

// Smoke runs use their own data folder, so they don't collide with a running copy (or its memory file).
if (SMOKE) app.setPath('userData', join(tmpdir(), `clueless-smoke-${process.pid}`))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Opened again from Finder or the Dock: show the main window.
  app.on('second-instance', () => openMain())
  app.whenReady().then(setup)
  app.on('activate', () => openMain())
  app.on('before-quit', () => controller?.saveNow()) // an unfinished problem still goes into History
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    voice?.cancelAll()
    watcher.stop()
  })
}
