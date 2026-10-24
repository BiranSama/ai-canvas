import { writePsdUint8Array, type Layer, type Psd } from 'ag-psd'

/** A layer filled with one colour, its alpha in a, at the given document bounds. */
function solid(name: string, left: number, top: number, width: number, height: number, rgba: readonly [number, number, number, number], extra: Partial<Layer> = {}): Layer {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < data.length; index += 4) data.set(rgba, index)
  return { name, left, top, right: left + width, bottom: top + height, blendMode: 'normal', opacity: 1, imageData: { width, height, data }, ...extra }
}

/**
 * A 200×100 PSD that exercises the import: an opaque 背景, a half-opaque
 * group holding a multiply layer and a hidden one, a soft-light layer whose
 * mask hides its right half, and a colour-dodge layer the canvas cannot
 * blend, which also brings the flattened image along.
 */
export function samplePsd(): Uint8Array {
  const maskData = new Uint8ClampedArray(40 * 20 * 4)
  for (let y = 0; y < 20; y += 1) for (let x = 0; x < 40; x += 1) maskData.fill(x < 20 ? 255 : 0, (y * 40 + x) * 4, (y * 40 + x) * 4 + 4)
  const composite = new Uint8ClampedArray(200 * 100 * 4)
  for (let index = 0; index < composite.length; index += 4) composite.set([200, 30, 30, 255], index)
  const psd: Psd = {
    width: 200,
    height: 100,
    imageData: { width: 200, height: 100, data: composite },
    children: [
      solid('背景', 0, 0, 200, 100, [200, 30, 30, 255]),
      {
        name: '标题组',
        opacity: 0.5,
        blendMode: 'pass through',
        opened: true,
        children: [
          solid('阴影', 10, 10, 20, 10, [0, 0, 255, 255], { blendMode: 'multiply' }),
          solid('草稿', 30, 30, 10, 10, [0, 255, 0, 255], { hidden: true })
        ]
      },
      solid('柔光', 100, 50, 40, 20, [255, 255, 0, 255], {
        blendMode: 'soft light',
        opacity: 0.8,
        mask: { left: 100, top: 50, right: 140, bottom: 70, defaultColor: 0, imageData: { width: 40, height: 20, data: maskData } }
      }),
      solid('减淡', 150, 0, 50, 50, [255, 255, 255, 128], { blendMode: 'color dodge' })
    ]
  }
  return writePsdUint8Array(psd)
}
