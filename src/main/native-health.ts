import Database from 'better-sqlite3'
import sharp from 'sharp'
import type { NativeModuleHealth } from '../shared/desktop-api'

interface SqliteVersionRow {
  readonly version: string
}

function inspectSqliteVersion(): string | null {
  try {
    const database = new Database(':memory:')
    const row = database.prepare('select sqlite_version() as version').get() as SqliteVersionRow
    database.close()
    return row.version
  } catch {
    return null
  }
}

async function inspectSharpVersion(): Promise<string | null> {
  try {
    const image = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 244, g: 243, b: 240, alpha: 1 }
      }
    })
      .png()
      .toBuffer()
    const metadata = await sharp(image).metadata()
    return metadata.format === 'png' ? sharp.versions.sharp : null
  } catch {
    return null
  }
}

export async function inspectNativeModules(): Promise<NativeModuleHealth> {
  const sqliteVersion = inspectSqliteVersion()
  const sharpVersion = await inspectSharpVersion()

  return {
    betterSqlite3: sqliteVersion !== null,
    sharp: sharpVersion !== null,
    sqliteVersion,
    sharpVersion
  }
}
