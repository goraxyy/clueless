// Exposes a small, typed API to the UI as `window.clueless`. The UI never touches Node or IPC directly.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, ISLAND_IPC, type CluelessApi, type IslandApi } from '../shared/contracts'

function listen<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_: unknown, value: T): void => cb(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: CluelessApi = {
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  getSession: () => ipcRenderer.invoke(IPC.getSession),
  onSession: (cb) => listen(IPC.session, cb),
  onStatus: (cb) => listen(IPC.status, cb),
  ask: (mode) => ipcRenderer.send(IPC.ask, mode),
  askText: (text) => ipcRenderer.send(IPC.askText, text),
  send: (input) => ipcRenderer.send(IPC.send, input),
  action: (action) => ipcRenderer.send(IPC.action, action),
  step: (id, intent) => ipcRenderer.send(IPC.step, { id, intent }),
  setSubject: (subject) => ipcRenderer.send(IPC.setSubject, subject),
  setWindowMode: (mode) => ipcRenderer.send(IPC.windowMode, mode),
  fitHeight: (px) => ipcRenderer.send(IPC.fitHeight, px),
  resizeWidth: (width, anchor) => ipcRenderer.send(IPC.resizeWidth, { width, anchor }),
  hide: () => ipcRenderer.send(IPC.hide),
  quit: () => ipcRenderer.send(IPC.quit),
  openScreenSettings: () => ipcRenderer.send(IPC.openScreenSettings),
  getMemory: () => ipcRenderer.invoke(IPC.getMemory),
  areaDone: (rect) => ipcRenderer.send(IPC.areaDone, rect),
  areaCancel: () => ipcRenderer.send(IPC.areaCancel),
  micAccess: () => ipcRenderer.invoke(IPC.voiceMicAccess),
  voiceStart: (id) => ipcRenderer.send(IPC.voiceStart, id),
  voiceAudio: (id, chunk) => ipcRenderer.send(IPC.voiceAudio, { id, chunk }),
  voiceStop: (id) => ipcRenderer.send(IPC.voiceStop, id),
  voiceCancel: (id) => ipcRenderer.send(IPC.voiceCancel, id),
  onVoiceTranscript: (cb) => listen(IPC.voiceTranscript, cb),
  onVoiceState: (cb) => listen(IPC.voiceState, cb),
  onVoiceToggle: (cb) => listen(IPC.voiceToggle, cb),
  tts: (req) => ipcRenderer.invoke(IPC.voiceTts, req),
  sendCode: (email) => ipcRenderer.invoke(IPC.accountSendCode, email),
  verifyCode: (email, code) => ipcRenderer.invoke(IPC.accountVerify, { email, code }),
  signOut: () => ipcRenderer.invoke(IPC.accountSignOut),
  getUsage: () => ipcRenderer.invoke(IPC.accountUsage),
  onStageIsland: (cb) => listen(IPC.stageIsland, cb),
  openMain: () => ipcRenderer.send(IPC.openMain),
  showPanel: () => ipcRenderer.send(IPC.showPanel),
  askFromMain: (mode) => ipcRenderer.send(IPC.askFromMain, mode),
  onMemoryChanged: (cb) => listen(IPC.memoryChanged, cb),
  listHistory: () => ipcRenderer.invoke(IPC.historyList),
  getHistory: (id) => ipcRenderer.invoke(IPC.historyGet, id),
  deleteHistory: (id) => ipcRenderer.invoke(IPC.historyDelete, id),
  listCards: () => ipcRenderer.invoke(IPC.cardsList),
  addCard: (card) => ipcRenderer.invoke(IPC.cardsAdd, card),
  updateCard: (id, patch) => ipcRenderer.invoke(IPC.cardsUpdate, { id, patch }),
  deleteCard: (id) => ipcRenderer.invoke(IPC.cardsDelete, id),
  reviewCard: (id, knew) => ipcRenderer.invoke(IPC.cardsReview, { id, knew }),
  getPermissions: () => ipcRenderer.invoke(IPC.permissions),
  requestPermission: (kind) => ipcRenderer.invoke(IPC.requestPermission, kind),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url)
}

contextBridge.exposeInMainWorld('clueless', api)

// The island: the pill, the Ask / Animate buttons, the panel's Ask card and the visual island.
const island: IslandApi = {
  getView: () => ipcRenderer.invoke(ISLAND_IPC.getView),
  onView: (cb) => listen(ISLAND_IPC.view, cb),
  setAskOnHighlight: (on) => ipcRenderer.send(ISLAND_IPC.setAskOnHighlight, on),
  followUp: (text) => ipcRenderer.send(ISLAND_IPC.followUp, text),
  close: () => ipcRenderer.send(ISLAND_IPC.close),
  hide: () => ipcRenderer.send(ISLAND_IPC.hide),
  resize: (size) => ipcRenderer.send(ISLAND_IPC.resize, size),
  resizeVisual: (size) => ipcRenderer.send(ISLAND_IPC.resizeVisual, size),
  ask: (animate) => ipcRenderer.send(ISLAND_IPC.ask, { animate }),
  play: () => ipcRenderer.send(ISLAND_IPC.play),
  pause: () => ipcRenderer.send(ISLAND_IPC.pause),
  step: (delta) => ipcRenderer.send(ISLAND_IPC.step, delta),
  replay: () => ipcRenderer.send(ISLAND_IPC.replay),
  stop: () => ipcRenderer.send(ISLAND_IPC.stop),
  setSpeed: (speed) => ipcRenderer.send(ISLAND_IPC.speed, speed),
  setVoice: (on) => ipcRenderer.send(ISLAND_IPC.voice, on),
  stepDone: (nonce, index) => ipcRenderer.send(ISLAND_IPC.stepDone, { nonce, index }),
  setNarrated: (on) => ipcRenderer.send(ISLAND_IPC.narrated, on)
}

contextBridge.exposeInMainWorld('island', island)
