import Database from 'better-sqlite3'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

describe('native module smoke', () => {
  it('loads better-sqlite3 and executes a query', () => {
    const database = new Database(':memory:')
    const row = database.prepare('select 42 as value').get() as { readonly value: number }
    database.close()

    expect(row.value).toBe(42)
  })

  it('loads Sharp and renders a deterministic PNG', async () => {
    const buffer = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 65, g: 111, b: 187, alpha: 1 }
      }
    })
      .png()
      .toBuffer()
    const metadata = await sharp(buffer).metadata()

    expect(metadata).toMatchObject({ format: 'png', width: 2, height: 2, channels: 4 })
  })
})
