import { create } from 'zustand'
import { createSceneInitializationCommands } from '../../../domain'
import type { WorkspaceBootstrap } from '../../../shared/project'
import { createMerchantExampleScene, MERCHANT_EXAMPLES, type MerchantExampleKey } from '../fixtures/merchant-examples'

/** What a project opened from an example suggests trying first, until its conversation has begun. */
export const useStarterPrompts = create<{ readonly prompts: Readonly<Record<string, readonly string[]>> }>(() => ({ prompts: {} }))

export const DEFAULT_STARTER_PROMPTS: readonly string[] = [
  '做一张 4:5 的咖啡店新品海报，标题写「秋日拿铁」',
  '做一张 1:1 的商品主图，主体是保温杯，突出 12 小时保温',
  '做一张 16:9 的店铺活动横幅，写「满 199 减 50」'
]

/**
 * A new project holding one of the examples, ready to open: Main creates it,
 * then lays the example out in one undoable batch, as if it had been drawn.
 * Null when the person cancelled.
 */
export async function createExampleProject(key: MerchantExampleKey): Promise<WorkspaceBootstrap | null> {
  const info = MERCHANT_EXAMPLES[key]
  const result = await window.desktop.createProject({ suggestedName: info.label })
  if (result.cancelled || result.bootstrap === null) return null
  const scene = createMerchantExampleScene(key, { projectId: result.bootstrap.scene.projectId, sceneId: result.bootstrap.scene.id })
  const initialized = await window.desktop.executeSceneCommands({
    projectId: result.bootstrap.projectId,
    expectedSceneRevision: result.bootstrap.scene.revision,
    batch: { id: globalThis.crypto.randomUUID(), origin: 'system', summary: `载入示例作品：${info.label}`, commands: [...createSceneInitializationCommands(scene)] }
  })
  if (!initialized.ok) throw new Error(initialized.error.message)
  useStarterPrompts.setState((state) => ({ prompts: { ...state.prompts, [result.bootstrap!.scene.projectId]: info.prompts } }))
  return { ...result.bootstrap, scene: initialized.receipt.state.scene, sceneSequence: initialized.receipt.state.sequence,
    canUndo: initialized.receipt.state.canUndo, canRedo: initialized.receipt.state.canRedo }
}
