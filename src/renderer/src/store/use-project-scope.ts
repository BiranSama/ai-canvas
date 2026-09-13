import { useCallback, useEffect, useRef, useState } from 'react'
import { projectGeneration } from './project-context-lifecycle'
import { useWorkspaceStore } from './workspace-store'

export function useProjectScope(projectId: string): () => boolean {
  const [generation] = useState(projectGeneration)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  return useCallback(() => active.current && projectGeneration() === generation
    && useWorkspaceStore.getState().scene.projectId === projectId, [generation, projectId])
}
