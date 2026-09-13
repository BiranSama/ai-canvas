import { z } from 'zod'
import type { Scene } from '../domain'
import type { ProjectWorkContext } from './project-work-context'

export const projectCreateInputSchema = z.object({
  suggestedName: z.string().trim().min(1).max(120).default('Untitled')
})

export const projectIdInputSchema = z.string().uuid()

export const projectFavoriteInputSchema = z.object({
  projectId: projectIdInputSchema,
  favorite: z.boolean()
})

export const projectLibraryChangeModeSchema = z.enum(['future', 'migrate'])

export const assetImportInputSchema = z.object({
  projectId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(260),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= 100 * 1024 * 1024, 'Image must be between 1 byte and 100 MB.')
})

export interface WorkspaceBootstrap {
  readonly workContext?: ProjectWorkContext | null
  readonly workContextProblem?: string | null
  readonly projectId: string
  readonly projectName: string
  readonly scene: Scene
  readonly sceneSequence: number
  readonly canUndo: boolean
  readonly canRedo: boolean
}

export interface ProjectActionResult {
  readonly cancelled: boolean
  readonly bootstrap: WorkspaceBootstrap | null
}

export interface RecentProjectSummary {
  readonly id: string
  readonly name: string
  readonly lastOpenedAt: string
  readonly aspectLabel: string
  readonly favorite: boolean
  readonly status: 'ready' | 'empty' | 'missing' | 'damaged' | 'asset-missing'
  readonly coverSource: 'generated' | 'scene' | 'fallback' | 'none'
  readonly coverDataUrl: string | null
  readonly deleteMode: 'trash' | 'remove'
}

export interface ProjectDeleteResult {
  readonly projectId: string
  readonly disposition: 'trashed' | 'removed'
  readonly projects: readonly RecentProjectSummary[]
  readonly replacementBootstrap: WorkspaceBootstrap | null
}

export interface ProjectLibrarySettings {
  readonly rootDirectory: string
  readonly updatedAt: string
}

export interface ProjectMigrationItem {
  readonly projectName: string
  readonly status: 'copied' | 'skipped' | 'failed'
  readonly assetCount: number
  readonly verifiedAssetCount: number
  readonly message: string
}

export interface ProjectLibraryMigrationReport {
  readonly id: string
  readonly sourceDirectory: string
  readonly destinationDirectory: string
  readonly startedAt: string
  readonly completedAt: string
  readonly switched: boolean
  readonly sourcePreserved: true
  readonly items: readonly ProjectMigrationItem[]
}

export interface ProjectLibraryLocationResult {
  readonly cancelled: boolean
  readonly settings: ProjectLibrarySettings
  readonly migration: ProjectLibraryMigrationReport | null
}

export interface ImportedAsset {
  readonly id: string
  readonly width: number
  readonly height: number
  readonly format: 'png' | 'jpeg' | 'webp'
  readonly hasAlpha: boolean
}

export type ProjectCreateInput = z.infer<typeof projectCreateInputSchema>
export type ProjectFavoriteInput = z.infer<typeof projectFavoriteInputSchema>
export type ProjectLibraryChangeMode = z.infer<typeof projectLibraryChangeModeSchema>
export type AssetImportInput = z.infer<typeof assetImportInputSchema>
