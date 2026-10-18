// The preload script provides `window.island` in every Clueless window.
import type { IslandApi } from '../../../shared/contracts'

export const islandApi: IslandApi = window.island
