// What macOS lets Clueless do, for the first-run walkthrough and settings: Screen Recording (needed
// to read problems), Accessibility (noticing highlights for Ask and Animate) and the Microphone
// (talking to it). Windows grants the first two without asking.
import { desktopCapturer, shell, systemPreferences } from 'electron'
import type { Access, PermissionName, PermissionsView } from '../shared/contracts'

const mac = process.platform === 'darwin'

function media(kind: 'screen' | 'microphone'): Access {
  const status = systemPreferences.getMediaAccessStatus(kind)
  if (status === 'granted' || status === 'denied' || status === 'not-determined') return status
  return status === 'restricted' ? 'denied' : 'unknown'
}

export function permissions(): PermissionsView {
  if (!mac) return { screen: 'granted', accessibility: 'granted', microphone: process.platform === 'win32' ? media('microphone') : 'granted' }
  return {
    screen: media('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
    microphone: media('microphone')
  }
}

const PANES: Record<PermissionName, string> = {
  screen: 'Privacy_ScreenCapture',
  accessibility: 'Privacy_Accessibility',
  microphone: 'Privacy_Microphone'
}

/** Ask for one: macOS's own prompt when it has one, otherwise the right page of System Settings. */
export async function askPermission(name: PermissionName): Promise<PermissionsView> {
  const now = permissions()[name]
  if (now === 'granted') return permissions()
  if (!mac) {
    if (name === 'microphone' && process.platform === 'win32') await shell.openExternal('ms-settings:privacy-microphone')
    return permissions()
  }
  if (name === 'microphone' && now === 'not-determined') {
    await systemPreferences.askForMediaAccess('microphone')
    return permissions()
  }
  // Adds Clueless to the list (switched off) so the student only has to flip it on.
  if (name === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true)
  if (name === 'screen') await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => [])
  await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PANES[name]}`)
  return permissions()
}
