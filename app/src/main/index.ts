// Clueless main process: windows, hotkeys, screen capture and IPC.
// Two ways in:
//   - the tutor panel (the main app): Ctrl/Cmd+Shift+Space reads the screen, +2 selects an area, +1 voice
//   - the island (Ctrl/Cmd+Shift+3): highlight anything, click Ask or Animate. The answer shows in
//     the panel; Animate also plays it step by step in the visual island (its own window, with a
//     voice) while the line it's on lights up on the student's screen
import {
  app,
  BrowserWindow,
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
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  IPC,
  ISLAND_IPC,
  type AppStatus,
  type HistoryView,
  type HotkeyName,
  type Hotkeys,
  type PermissionName,
  type CodeSpot,
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
import { Account } from './account/account'
import { accountServer } from './account/project'
import { EncryptedFileStorage } from './account/storage'
import {
  activeDisplay,
  captureDisplay,
  cropToRect,
  grayThumbnail,
  screenAccess,
  toModelImage,
  windowTitles
} from './capture/capture'
import { loadEnvFiles } from './env'
import { SelectionWatcher, type Point } from './island/selection'
import { grayFromBitmap, spotFromSelection } from './island/spot'
import { Tracer } from './island/tracer'
import { PythonRunner, toCodeTrace } from './run/python'
import { localHidden, serverHidden } from './memory/continue'
import { HistoryStore } from './memory/history'
import { autoUpdater } from 'electron-updater'
import { HistorySync } from './memory/sync'
import { Updates } from './update/updates'
import { askPermission, permissions } from './permissions'
import { DEFAULT_HOTKEYS, SettingsStore } from './settings/settings'
import { SessionController } from './session'
import { StuckDetector } from './stuck/detector'
import { createTransport, providerInfo } from './tutor/provider'
import { Tutor, type ImageInput } from './tutor/tutor'
import { VoiceManager, type SocketLike } from './voice/deepgram'
import { ElevenLabs } from './voice/elevenlabs'
import { ServerVoice } from './voice/server'
import { createTray } from './windows/tray'
import {
  createAskButton,
  createIsland,
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
let settings = new SettingsStore(null) // the real one opens in setup, once the data folder is known
let trayMenu: { setHotkeys(hotkeys: Hotkeys): void } | null = null
let account: Account | null = null // null = this build has no account server (developers use .env keys)
let serverVoice: ServerVoice | null = null // voice through the account server, for students without keys
let history = new HistoryStore(null) // replaced in setup by the right person's history
let historySync: HistorySync | null = null // null: no account, history stays on this laptop
let updates: Updates | null = null // only in the installed app
let historyOwner: string | null = null // the account id whose history is open, 'local', or '' (nobody signed in)

const userEnvFile = (): string => join(app.getPath('userData'), '.env')
const log = (line: string): void => console.log(`[clueless] ${line}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const contains = (r: Rectangle, p: Point): boolean => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height

function loadKeys(): void {
  // Dev: app/.env. Installed app: the .env in the user data folder (shown in the UI).
  loadEnvFiles([join(process.cwd(), '.env'), join(app.getAppPath(), '.env'), userEnvFile()])
}

function status(): AppStatus {
  const ai = providerInfo()
  return {
    platform: process.platform,
    provider: ai?.provider ?? null,
    model: ai?.model ?? null,
    region: ai?.region ?? null,
    hasDeepgramKey: Boolean(process.env.DEEPGRAM_API_KEY),
    screenAccess: screenAccess(),
    hotkeys: settings.current.hotkeys,
    hotkeyErrors,
    envFile: app.isPackaged ? userEnvFile() : join(process.cwd(), '.env'),
    account: account?.current ?? null,
    update: updates?.current ?? null,
    version: app.getVersion(),
    firstRun: !settings.current.firstRunDone
  }
}

/** The student's token for Clueless's server (undefined: no account server in this build). */
const accessToken = (): (() => Promise<string | null>) | undefined => (account ? () => account!.accessToken() : undefined)

/** Claude goes through the student's account and they haven't finished signing in: show the panel instead. */
function needsSignIn(): boolean {
  if (providerInfo()?.provider !== 'clueless' || account?.current.state === 'ready') return false
  showOverlay()
  return true
}

function historyView(): HistoryView {
  return { sessions: history.list(), sync: historySync ? historySync.status : 'local' }
}

/**
 * Open the history of whoever uses Clueless now: the signed-in student's (synced), or this
 * laptop's when there's no account server (developers' own keys). Signed out: nothing.
 */
function openHistoryForCurrentUser(): void {
  const usesAccount = providerInfo()?.provider === 'clueless'
  const owner = !usesAccount ? 'local' : account?.current.state === 'ready' || account?.current.state === 'needs-invite' ? (account.userId ?? '') : ''
  if (owner === historyOwner) return
  historySync?.stop()
  historySync = null
  historyOwner = owner
  const dir = app.getPath('userData')
  const legacy = join(dir, 'clueless-memory.json') // the memory file from before accounts
  const onChange = (): void => {
    historySync?.soon()
    toUi(IPC.history, historyView())
  }
  if (owner === 'local') {
    const file = join(dir, 'history-local.json')
    const first = !existsSync(file)
    history = new HistoryStore(file, onChange)
    if (first) history.importLegacy(legacy, null)
  } else if (owner && account) {
    history = new HistoryStore(join(dir, `history-${owner}.json`), onChange)
    const moved = history.importLegacy(legacy, owner) // once: the first account on this laptop gets it
    if (moved) log(`history: moved ${moved} older sessions into the account`)
    historySync = new HistorySync(history, account.supabase, () => toUi(IPC.history, historyView()), log)
    void historySync.sync()
  } else {
    history = new HistoryStore(null)
  }
  toUi(IPC.history, historyView())
}

/** Continue a saved session: download it if needed, then a new tutor picks it up. */
async function continueSession(id: string): Promise<void> {
  if (needsSignIn()) return
  showOverlay()
  // A secret still on this laptop has to reach the server before the server can fill it in.
  if (historySync && history.secret(id)) await historySync.sync()
  const saved = historySync ? await historySync.open(id) : history.get(id)
  if (!saved?.thread) {
    controller.fail("Couldn't open that session. Check your internet connection and try again.")
    return
  }
  const hidden = historySync ? serverHidden(id) : localHidden(history.secret(id))
  await controller.resume(saved, hidden)
}

let usageReadAt = 0
/** Re-read this week's use now and then (each Claude request changes it). */
function refreshUsageSoon(): void {
  if (!account || account.current.state !== 'ready' || Date.now() - usageReadAt < 30_000) return
  usageReadAt = Date.now()
  void account.refresh()
}

function toUi(channel: string, payload: unknown): void {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload)
}

function makeTutor(): Tutor | null {
  const transport = createTransport(process.env, 'tutor', accessToken()) // Clueless server, Claude API or Bedrock
  return transport ? new Tutor(transport, log) : null
}

function showOverlay(): void {
  if (!overlay) return
  // No app.focus() here: on macOS the panel takes keyboard focus without activating the app,
  // so a full-screen browser stays in its own Space instead of being switched away from.
  overlay.show()
  overlay.focus()
  refreshUsageSoon()
}

function toggleOverlay(): void {
  if (overlay?.isVisible()) overlay.hide()
  else showOverlay()
}

/** Clueless's own windows that are on screen right now. */
function ownVisibleWindows(): BrowserWindow[] {
  return [overlay, stage, island, askButton, visual].filter((w): w is BrowserWindow => Boolean(w && !w.isDestroyed() && w.isVisible()))
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
  if (capturing || needsSignIn()) return
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
  if (capturing || needsSignIn()) return
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
    const tutor = createTransport(process.env, 'tutor', accessToken())
    const fast = createTransport(process.env, 'fast', accessToken())
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
  else if (!needsSignIn()) showIsland()
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

const HOTKEY_ACTIONS: Record<HotkeyName, () => void> = {
  ask: () => void ask('screen'),
  area: () => void ask('area'),
  voice: () => {
    showOverlay()
    toUi(IPC.voiceToggle, null)
  },
  island: () => toggleIsland()
}
let registered: string[] = []

/** (Re)register the student's hotkeys. Ones another app already has are listed in the panel. */
function registerHotkeys(): void {
  for (const accelerator of registered) globalShortcut.unregister(accelerator)
  registered = []
  hotkeyErrors.length = 0
  for (const [name, accelerator] of Object.entries(settings.current.hotkeys) as [HotkeyName, string][]) {
    if (globalShortcut.register(accelerator, HOTKEY_ACTIONS[name])) registered.push(accelerator)
    else hotkeyErrors.push(`${accelerator} is taken by another app`)
  }
  trayMenu?.setHotkeys(settings.current.hotkeys)
}

/** The student picked a new shortcut in settings. Returns why it can't be used, or null. */
function setHotkey(name: HotkeyName, accelerator: unknown): string | null {
  const problem = settings.hotkeyProblem(name, accelerator)
  if (problem) return problem
  const before = settings.current.hotkeys
  settings.update({ hotkeys: { ...before, [name]: accelerator as string } })
  registerHotkeys()
  if (!registered.includes(accelerator as string)) {
    settings.update({ hotkeys: before }) // another app has it: keep the old one
    registerHotkeys()
    return 'Another app already uses that shortcut.'
  }
  return null
}

/** The Highlight switch: Ask and Animate next to a highlight, or not. Remembered across launches. */
function applyAskOnHighlight(on: boolean): void {
  askOnHighlight = on
  settings.update({ askOnHighlight: on })
  if (!askOnHighlight) hideAskButton()
  islandController.setAskOnHighlight(askOnHighlight)
}

function setup(): void {
  settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
  askOnHighlight = settings.current.askOnHighlight
  islandController.setAskOnHighlight(askOnHighlight)
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
  const server = accountServer()
  if (server) {
    account = new Account({
      server,
      storage: new EncryptedFileStorage(join(app.getPath('userData'), 'account.bin')),
      openExternal: (url) => shell.openExternal(url),
      onChange: () => {
        toUi(IPC.status, status())
        openHistoryForCurrentUser()
      },
      log
    })
    void account.refresh()
    serverVoice = new ServerVoice(server, () => account!.accessToken(), fetch, log)
  }
  openHistoryForCurrentUser()

  // The installed app updates itself from GitHub Releases (not in development or smoke runs).
  if (app.isPackaged && !SMOKE) {
    autoUpdater.logger = null // Updates logs what matters
    updates = new Updates(autoUpdater, () => toUi(IPC.status, status()), log)
    updates.start()
  }

  stuck = new StuckDetector({
    thumbnail: () => grayThumbnail(activeDisplay()),
    windowTitles,
    isCluelessFocused: () => Boolean(overlay?.isFocused()),
    onChange: (state) => controller.setStuck(state)
  })

  controller = new SessionController({
    makeTutor,
    memory: () => history,
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
    token: serverVoice ? () => serverVoice!.listenToken() : undefined,
    events: {
      transcript: (t) => toUi(IPC.voiceTranscript, t),
      state: (e) => toUi(IPC.voiceState, e)
    },
    // Node's built-in WebSocket (no extra package).
    // Node's WebSocket also takes headers (not standard, but Node's own), for the server's tokens.
    makeSocket: (url, protocols, headers) =>
      new WebSocket(url, (headers ? { protocols, headers } : protocols) as string[]) as unknown as SocketLike
  })

  ipcMain.handle(IPC.getStatus, () => status())
  ipcMain.handle(IPC.getSession, () => controller.current)
  ipcMain.handle(IPC.getMemory, () => history.view())
  ipcMain.handle(IPC.getHistory, () => {
    void historySync?.sync() // the latest from other computers arrives as an update
    return historyView()
  })
  ipcMain.handle(IPC.openHistory, async (_e, id: unknown) => {
    if (typeof id !== 'string') return null
    return historySync ? historySync.open(id) : history.get(id)
  })
  ipcMain.handle(IPC.deleteHistory, (_e, id: unknown) => {
    if (typeof id === 'string') history.remove(id)
    return historyView()
  })
  ipcMain.handle(IPC.deleteAllHistory, () => {
    history.removeAll()
    return historyView()
  })
  ipcMain.on(IPC.historyContinue, (_e, id: unknown) => {
    if (typeof id === 'string') void continueSession(id)
  })
  ipcMain.handle(IPC.accountGoogle, () => account?.signInWithGoogle() ?? null)
  ipcMain.handle(IPC.accountEmail, (_e, email: unknown) => (typeof email === 'string' ? account?.sendEmailLink(email.slice(0, 320)) : null) ?? null)
  ipcMain.handle(IPC.accountCancel, () => account?.cancel() ?? null)
  ipcMain.handle(IPC.accountActivate, (_e, arg: { invite?: unknown; adult?: unknown }) =>
    account && typeof arg?.invite === 'string' ? account.activate(arg.invite.slice(0, 64), arg.adult === true) : null
  )
  ipcMain.handle(IPC.accountSignOut, async () => {
    const view = (await account?.signOut()) ?? null
    void controller.action('new') // the next student starts clean
    islandController.close()
    return view
  })
  ipcMain.handle(IPC.accountRefresh, () => account?.refresh() ?? null)
  ipcMain.on(IPC.ask, (_e, mode: 'screen' | 'area') => void ask(mode === 'area' ? 'area' : 'screen'))
  ipcMain.on(IPC.askText, (_e, text: string) => {
    if (typeof text !== 'string' || !text.trim()) return
    void askWithText(text.slice(0, 8000))
  })
  ipcMain.on(IPC.send, (_e, arg: { text: string; as: InputKind }) => {
    if (typeof arg?.text !== 'string') return
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
  ipcMain.on(IPC.installUpdate, () => updates?.install())
  ipcMain.handle(IPC.setHotkey, (_e, arg: { name?: unknown; accelerator?: unknown }) => {
    if (!arg || !(Object.keys(DEFAULT_HOTKEYS) as unknown[]).includes(arg.name)) return 'Unknown shortcut.'
    const problem = setHotkey(arg.name as HotkeyName, arg.accelerator)
    toUi(IPC.status, status())
    return problem
  })
  ipcMain.handle(IPC.getPermissions, () => {
    const now = permissions()
    if (now.accessibility === 'granted') watchHighlights() // just allowed: start noticing highlights, no restart needed
    return now
  })
  ipcMain.handle(IPC.askPermission, (_e, name: unknown) =>
    name === 'screen' || name === 'accessibility' || name === 'microphone' ? askPermission(name as PermissionName) : permissions()
  )
  ipcMain.on(IPC.finishFirstRun, () => {
    settings.update({ firstRunDone: true })
    toUi(IPC.status, status())
  })
  ipcMain.on(IPC.relaunch, () => {
    app.relaunch()
    app.exit(0)
  })
  ipcMain.on(IPC.openScreenSettings, () => openScreenSettings())
  ipcMain.on(IPC.areaDone, (_e, rect: Rect) => resolveAreaSelection(rect))
  ipcMain.on(IPC.areaCancel, () => resolveAreaSelection(null))

  ipcMain.handle(ISLAND_IPC.getView, () => islandController.current)
  ipcMain.on(ISLAND_IPC.setAskOnHighlight, (_e, on: unknown) => {
    applyAskOnHighlight(Boolean(on))
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
    log
  )
  // A developer's own ElevenLabs key, else the account server (which may say "use the computer's voice").
  ipcMain.handle(IPC.voiceTts, (_e, req: unknown) =>
    !process.env.ELEVENLABS_API_KEY?.trim() && serverVoice ? serverVoice.speak(req) : elevenLabs.speak(req)
  )
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

  const tray = createTray({
    ask: () => void ask('screen'),
    selectArea: () => void ask('area'),
    toggle: toggleOverlay,
    toggleIsland,
    quit: () => app.quit(),
    hotkeys: settings.current.hotkeys
  })
  keepAlive.push(tray.tray)
  trayMenu = tray

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
      showOverlay()
    }, 800)
  )
  registerHotkeys()
  watchHighlights()
  const h = settings.current.hotkeys
  log(`ready. Ask: ${h.ask}  Select area: ${h.area}  Voice: ${h.voice}  Island: ${h.island}`)
}

// Smoke runs use their own data folder, so they don't collide with a running copy (or its memory file).
if (SMOKE) app.setPath('userData', join(tmpdir(), `clueless-smoke-${process.pid}`))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showOverlay())
  app.whenReady().then(setup)
  app.on('activate', () => showOverlay())
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    voice?.cancelAll()
    watcher.stop()
    account?.stop()
    historySync?.stop()
    updates?.stop()
  })
}
