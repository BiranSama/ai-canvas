import { ToolLoopAgent, isStepCount, tool, type LanguageModel } from 'ai'
import type { AgentSdkToolRequest } from '../../shared/agent'
import { cancelGenerationToolSchema, canvasEditToolSchema, canvasGenerationToolSchema, generationToolSchema, readSceneToolSchema, sceneBatchToolSchema } from '../../shared/agent'

export type AgentToolExecutor = (plan: AgentSdkToolRequest, signal: AbortSignal) => Promise<unknown>

function executionSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal
}

export function createAiSdkToolLoopAgent(model: LanguageModel, executor: AgentToolExecutor, maxSteps = 8) {
  return new ToolLoopAgent({
    id: 'ai-canvas-creative-agent',
    model,
    instructions: 'Start from the supplied compact scene summary. Read only the relevant element IDs when exact details are needed. Operate the current AI Canvas project using only the provided tools. Never expose internal tool JSON.',
    stopWhen: isStepCount(maxSteps),
    tools: {
      readScene: tool({
        description: 'Read exact details for up to 100 relevant scene elements by ID after inspecting the compact scene summary.',
        inputSchema: readSceneToolSchema,
        execute: (input, context) => executor(input, executionSignal(context.abortSignal))
      }),
      applySceneBatch: tool({
        description: 'Apply one atomic, undoable batch of validated scene commands.',
        inputSchema: sceneBatchToolSchema,
        execute: (input, context) => executor(input, executionSignal(context.abortSignal))
      }),
      generateImage: tool({
        description: 'Create a persistent image generation job under the current generation policy.',
        inputSchema: generationToolSchema,
        execute: (input, context) => executor(input, executionSignal(context.abortSignal))
      }),
      generateCanvas: tool({
        description: 'Compile the current structured scene into a Composite Reference and create a persistent full-image generation job.',
        inputSchema: canvasGenerationToolSchema,
        execute: (input, context) => executor(input, executionSignal(context.abortSignal))
      }),
      editCanvasImage: tool({
        description: 'Create a persistent non-destructive mask edit job for a selected image that already has an edit mask.',
        inputSchema: canvasEditToolSchema,
        execute: (input, context) => executor(input, executionSignal(context.abortSignal))
      }),
      cancelGeneration: tool({
        description: 'Cancel the currently scoped generation job.',
        inputSchema: cancelGenerationToolSchema,
        execute: (input, context) => executor(input, executionSignal(context.abortSignal))
      })
    }
  })
}
