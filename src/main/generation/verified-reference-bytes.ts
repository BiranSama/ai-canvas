import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ProviderError } from './provider'

/** Validate the same buffer passed to the protocol; never check a path then reread it. */
export async function readVerifiedReferenceBytes(filePath: string, contentHash: string): Promise<Buffer> {
  let bytes: Buffer
  try { bytes = await readFile(filePath) } catch {
    throw new ProviderError('REFERENCE_ASSET_UNAVAILABLE', '参考素材无法读取，请重新导入并核对。', 'validating')
  }
  if (createHash('sha256').update(bytes).digest('hex') !== contentHash) {
    throw new ProviderError('REFERENCE_ASSET_CHANGED', '参考文件内容已经变化，请重新导入并核对。', 'validating')
  }
  return bytes
}
