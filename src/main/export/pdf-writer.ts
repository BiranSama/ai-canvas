import { deflateSync } from 'node:zlib'

/*
 * A one-page PDF holding one picture, which is all an exported artwork
 * needs: the page at its size in points, the picture stretched over it.
 * Opaque pictures go in as JPEG; transparent ones as lossless RGB with a
 * gray soft mask, so the transparency survives.
 */

export type PdfPicture =
  | { readonly kind: 'jpeg'; readonly bytes: Uint8Array; readonly width: number; readonly height: number }
  | { readonly kind: 'rgba'; readonly pixels: Uint8Array; readonly width: number; readonly height: number }

export interface PdfPage {
  readonly title: string
  /** In points, 1/72 inch. */
  readonly width: number
  readonly height: number
  readonly picture: PdfPicture
  readonly createdAt?: Date
}

function number(value: number): string {
  return Number(value.toFixed(3)).toString()
}

/** A text string any reader shows, Chinese included: UTF-16BE with its byte order mark, in hex. */
function textString(value: string): string {
  let hex = 'FEFF'
  for (let index = 0; index < value.length; index += 1) hex += value.charCodeAt(index).toString(16).padStart(4, '0').toUpperCase()
  return `<${hex}>`
}

function pdfDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `(D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z)`
}

/** The picture's colour as RGB and its transparency as gray, each compressed. */
function planes(pixels: Uint8Array, width: number, height: number): { readonly rgb: Buffer; readonly alpha: Buffer } {
  const count = width * height
  const rgb = Buffer.alloc(count * 3)
  const alpha = Buffer.alloc(count)
  for (let pixel = 0; pixel < count; pixel += 1) {
    rgb[pixel * 3] = pixels[pixel * 4]!
    rgb[pixel * 3 + 1] = pixels[pixel * 4 + 1]!
    rgb[pixel * 3 + 2] = pixels[pixel * 4 + 2]!
    alpha[pixel] = pixels[pixel * 4 + 3]!
  }
  return { rgb: deflateSync(rgb), alpha: deflateSync(alpha) }
}

export function buildPdf(page: PdfPage): Uint8Array {
  const chunks: Buffer[] = []
  const offsets: number[] = []
  let length = 0
  const write = (chunk: string | Buffer | Uint8Array): void => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    chunks.push(buffer)
    length += buffer.length
  }
  const object = (id: number, body: string, stream?: Buffer | Uint8Array): void => {
    offsets[id] = length
    write(`${id} 0 obj\n${body}\n`)
    if (stream !== undefined) {
      write('stream\n')
      write(stream)
      write('\nendstream\n')
    }
    write('endobj\n')
  }

  const { picture } = page
  const width = number(page.width)
  const height = number(page.height)
  const content = Buffer.from(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`, 'latin1')
  const hasMask = picture.kind === 'rgba'
  const compressed = picture.kind === 'rgba' ? planes(picture.pixels, picture.width, picture.height) : null

  write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)
  if (picture.kind === 'jpeg') {
    object(4, `<< /Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${picture.bytes.byteLength} >>`, picture.bytes)
  } else {
    object(4, `<< /Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 7 0 R /Length ${compressed!.rgb.length} >>`, compressed!.rgb)
  }
  object(5, `<< /Length ${content.length} >>`, content)
  object(6, `<< /Title ${textString(page.title)} /Producer (AI Canvas) /CreationDate ${pdfDate(page.createdAt ?? new Date())} >>`)
  if (hasMask) {
    object(7, `<< /Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed!.alpha.length} >>`, compressed!.alpha)
  }

  const count = hasMask ? 8 : 7
  const xref = length
  write(`xref\n0 ${count}\n0000000000 65535 f \n`)
  for (let id = 1; id < count; id += 1) write(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)
  write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Uint8Array(Buffer.concat(chunks, length))
}
