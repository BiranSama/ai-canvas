import { readFile, writeFile } from 'node:fs/promises'
import type { Sharp } from 'sharp'

/*
 * Sharp's own file reading and writing goes through libvips, which on
 * Windows cannot open a path longer than 260 characters, and a project kept
 * deep in someone's folders passes that easily. Node's file system has no
 * such limit, so image files are read and written through it.
 */

/** An image file's bytes, or the bytes as given. */
export async function imageBytes(source: string | Buffer): Promise<Buffer> {
  return typeof source === 'string' ? readFile(source) : source
}

/** Writes what the pipeline produces to a file. */
export async function writeImage(image: Sharp, path: string): Promise<void> {
  await writeFile(path, await image.toBuffer())
}
