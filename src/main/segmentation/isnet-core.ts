import type { InferenceSession } from 'onnxruntime-node'
import { SUBJECT_MODEL_SIZE } from '../../shared/segmentation'

/*
 * ISNet on ONNX Runtime, as rembg runs it: the picture scaled to 1024², each
 * channel divided by the brightest value and centred on 0.5; the first
 * output stretched to 0–1 and read as how surely each pixel is the subject.
 * On Windows the graphics card is tried first through DirectML.
 */

export async function createIsnetSession(modelPath: string): Promise<InferenceSession> {
  const ort = await import('onnxruntime-node')
  const options = { graphOptimizationLevel: 'all' as const }
  if (process.platform === 'win32') {
    try {
      return await ort.InferenceSession.create(modelPath, { ...options, executionProviders: ['dml', 'cpu'] })
    } catch {
      // No usable graphics card: the processor does it.
    }
  }
  return ort.InferenceSession.create(modelPath, { ...options, executionProviders: ['cpu'] })
}

/** rgb is the picture at 1024², three bytes a pixel; returns the subject's coverage at 1024², one byte a pixel. */
export async function runIsnet(session: InferenceSession, rgb: Uint8Array): Promise<Uint8Array> {
  const ort = await import('onnxruntime-node')
  const size = SUBJECT_MODEL_SIZE
  const plane = size * size
  let brightest = 1e-6
  for (let index = 0; index < plane * 3; index += 1) if (rgb[index]! > brightest) brightest = rgb[index]!
  const input = new Float32Array(plane * 3)
  for (let pixel = 0; pixel < plane; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) input[channel * plane + pixel] = rgb[pixel * 3 + channel]! / brightest - 0.5
  }
  const outputs = await session.run({ [session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, size, size]) })
  const prediction = outputs[session.outputNames[0]!]!.data as Float32Array
  let low = Infinity
  let high = -Infinity
  for (let index = 0; index < plane; index += 1) {
    const value = prediction[index]!
    if (value < low) low = value
    if (value > high) high = value
  }
  const range = high - low > 1e-9 ? high - low : 1
  const mask = new Uint8Array(plane)
  for (let index = 0; index < plane; index += 1) mask[index] = Math.round((prediction[index]! - low) / range * 255)
  return mask
}
