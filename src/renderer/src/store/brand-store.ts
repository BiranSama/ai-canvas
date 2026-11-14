import { create } from 'zustand'
import { useWorkspaceStore } from './workspace-store'

/*
 * The brand as the editor offers it: colours first in the colour pickers,
 * fonts first in the font list, 插入 Logo in the layer panel. Empty when the
 * open project turned 使用品牌 off, the same as for the Agent.
 */

/** The id of the colour list every colour input in the editor points at. */
export const BRAND_COLOR_LIST_ID = 'brand-colors'

interface BrandState {
  readonly colors: readonly string[]
  readonly fonts: readonly { readonly family: string; readonly note: string }[]
  readonly hasLogo: boolean
  /** Learned or proposed preferences waiting for the person, across projects. */
  readonly pendingPreferences: number
  readonly set: (state: Partial<Pick<BrandState, 'colors' | 'fonts' | 'hasLogo' | 'pendingPreferences'>>) => void
}

export const useBrandStore = create<BrandState>((set) => ({
  colors: [],
  fonts: [],
  hasLogo: false,
  pendingPreferences: 0,
  set: (state) => set(state)
}))

async function loadBrand(): Promise<void> {
  const desktop = window.desktop as Partial<typeof window.desktop>
  if (desktop.getUserMemory === undefined) return
  const projectId = useWorkspaceStore.getState().scene.projectId
  const snapshot = await desktop.getUserMemory().catch(() => null)
  // A project opened meanwhile loads its own.
  if (snapshot === null || useWorkspaceStore.getState().scene.projectId !== projectId) return
  useBrandStore.getState().set({ pendingPreferences: snapshot.candidates.filter((candidate) => candidate.status === 'pending').length })
  if (!snapshot.projectUsesBrand) {
    useBrandStore.getState().set({ colors: [], fonts: [], hasLogo: false })
    return
  }
  const { brand } = snapshot
  const fonts = [
    ...(brand.titleFont === '' ? [] : [{ family: brand.titleFont, note: '品牌标题字体' }]),
    ...(brand.bodyFont === '' || brand.bodyFont === brand.titleFont ? [] : [{ family: brand.bodyFont, note: '品牌正文字体' }])
  ]
  useBrandStore.getState().set({ colors: brand.colors, fonts, hasLogo: brand.logo !== null })
}

/** Keeps the editor's brand current: on start, when settings change it, and when another project opens. */
export function startBrandSync(): () => void {
  void loadBrand()
  const desktop = window.desktop as Partial<typeof window.desktop>
  const offMemory = desktop.onUserMemoryChanged?.(() => void loadBrand())
  let projectId = useWorkspaceStore.getState().scene.projectId
  const offProject = useWorkspaceStore.subscribe((state) => {
    if (state.scene.projectId === projectId) return
    projectId = state.scene.projectId
    void loadBrand()
  })
  return () => {
    offMemory?.()
    offProject()
  }
}
