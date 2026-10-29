import type { InferenceSession } from 'onnxruntime-node'
import { createIsnetSession, runIsnet } from './isnet-core'

/*
 * The background process Select Subject runs in, so a second of model work
 * never holds up the app. Main sends the model's path and a 1024² picture;
 * the session stays loaded until Main lets the process go.
 */

interface Request {
  readonly id: number
  readonly modelPath: string
  readonly rgb: Uint8Array
}

let loaded: { readonly path: string; readonly session: Promise<InferenceSession> } | null = null

process.parentPort.on('message', (event) => {
  const request = event.data as Request
  void (async () => {
    try {
      if (loaded?.path !== request.modelPath) loaded = { path: request.modelPath, session: createIsnetSession(request.modelPath) }
      const mask = await runIsnet(await loaded.session, request.rgb)
      process.parentPort.postMessage({ id: request.id, mask })
    } catch (error) {
      loaded = null
      process.parentPort.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
    }
  })()
})
