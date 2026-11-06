// Menu-bar (macOS) / system-tray (Windows) icon. Clueless runs in the background (no dock icon on
// macOS, which is what lets it float over full-screen apps), so this is where you open the tutor
// panel or the island, and quit.
import { Menu, nativeImage, Tray } from 'electron'
import { MAC1X, MAC2X, WIN } from './trayIcons'

export interface TrayActions {
  ask(): void
  selectArea(): void
  toggle(): void
  toggleIsland(): void
  quit(): void
  hotkeys: { ask: string; area: string; island: string }
}

/** The tray, and a way to show new hotkeys in its menu after the student changes them. */
export function createTray(actions: TrayActions): { tray: Tray; setHotkeys(hotkeys: TrayActions['hotkeys']): void } {
  let icon
  if (process.platform === 'darwin') {
    icon = nativeImage.createFromDataURL(MAC1X)
    icon.addRepresentation({ scaleFactor: 2, dataURL: MAC2X })
    icon.setTemplateImage(true) // macOS colors it to match the menu bar
  } else {
    icon = nativeImage.createFromDataURL(WIN)
  }

  const tray = new Tray(icon)
  tray.setToolTip('Clueless')
  const setHotkeys = (hotkeys: TrayActions['hotkeys']): void =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Read my screen', accelerator: hotkeys.ask, click: actions.ask },
        { label: 'Select just the problem', accelerator: hotkeys.area, click: actions.selectArea },
        { label: 'Show / hide the panel', click: actions.toggle },
        { type: 'separator' },
        { label: 'Show / hide the island', accelerator: hotkeys.island, click: actions.toggleIsland },
        { type: 'separator' },
        { label: 'Quit Clueless', role: 'quit', click: actions.quit }
      ])
    )
  setHotkeys(actions.hotkeys)
  // Windows: a left click toggles the panel (the menu is on right click).
  if (process.platform === 'win32') tray.on('click', actions.toggle)
  return { tray, setHotkeys }
}
