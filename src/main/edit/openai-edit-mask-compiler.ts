import sharp from 'sharp'

/** Main stores white-to-edit grayscale masks for all image providers. OpenAI
 * Images instead edits transparent pixels; preserve the grayscale feathering
 * as inverse alpha, without changing the saved project asset or other adapters.
 * https://developers.openai.com/api/docs/guides/image-generation#mask-requirements
 */
export async function compileOpenAiEditMask(mask: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(mask, { limitInputPixels: 80_000_000 }).greyscale().removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const alpha = Buffer.from(data)
  for (let index = 0; index < alpha.length; index++) alpha[index] = 255 - alpha[index]!
  return sharp({ create: { width: info.width, height: info.height, channels: 3, background: '#000000' } })
    .joinChannel(alpha, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer()
}
