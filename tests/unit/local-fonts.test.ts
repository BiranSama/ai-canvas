import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { faceNames, groupFontFaces, LocalFontCatalog, readFontFile, systemFontDirectories } from '../../src/main/fonts/local-font-catalog'
import { findLocalFont, fontLabel, searchLocalFonts } from '../../src/shared/local-fonts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

type Name = readonly [platform: number, language: number, nameId: number, value: string]

/** A name table with Windows (UTF-16BE) and Mac Roman records. */
function nameTable(names: readonly Name[]): Buffer {
  const strings = names.map(([platform, , , value]) => platform === 1 ? Buffer.from(value, 'latin1') : Buffer.from(value, 'utf16le').swap16())
  const header = Buffer.alloc(6 + names.length * 12)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(names.length, 2)
  header.writeUInt16BE(header.length, 4)
  let offset = 0
  names.forEach(([platform, language, nameId], index) => {
    const at = 6 + index * 12
    header.writeUInt16BE(platform, at)
    header.writeUInt16BE(platform === 1 ? 0 : 1, at + 2)
    header.writeUInt16BE(language, at + 4)
    header.writeUInt16BE(nameId, at + 6)
    header.writeUInt16BE(strings[index]!.length, at + 8)
    header.writeUInt16BE(offset, at + 10)
    offset += strings[index]!.length
  })
  return Buffer.concat([header, ...strings])
}

function os2Table(codePages: number): Buffer {
  const table = Buffer.alloc(96)
  table.writeUInt16BE(4, 0)
  table.writeUInt32BE(codePages >>> 0, 78)
  return table
}

/** One sfnt face whose tables start at `base` in the file. */
function face(base: number, names: readonly Name[], codePages = 0): Buffer {
  const name = nameTable(names)
  const os2 = os2Table(codePages)
  const directory = Buffer.alloc(12 + 2 * 16)
  directory.writeUInt32BE(0x00010000, 0)
  directory.writeUInt16BE(2, 4)
  const nameAt = base + directory.length
  directory.write('name', 12, 'latin1')
  directory.writeUInt32BE(nameAt, 20)
  directory.writeUInt32BE(name.length, 24)
  directory.write('OS/2', 28, 'latin1')
  directory.writeUInt32BE(nameAt + name.length, 36)
  directory.writeUInt32BE(os2.length, 40)
  return Buffer.concat([directory, name, os2])
}

const EN = 0x0409
const ZH = 0x0804
const CHINESE_CODE_PAGE = 1 << 18

describe('local font catalog', () => {
  it('reads the English family, the Chinese name, the style and Chinese coverage', () => {
    const names: Name[] = [[3, EN, 1, 'Microsoft YaHei UI'], [3, EN, 16, 'Microsoft YaHei'], [3, EN, 2, 'Bold'], [3, ZH, 1, '微软雅黑']]
    expect(faceNames(nameTable(names), os2Table(CHINESE_CODE_PAGE))).toEqual({ family: 'Microsoft YaHei', localName: '微软雅黑', style: 'Bold', chinese: true })
    // Mac-only names still give a family; no code page and no Chinese name means not Chinese.
    expect(faceNames(nameTable([[1, 0, 1, 'Georgia'], [1, 0, 2, 'Italic']]), null)).toEqual({ family: 'Georgia', localName: null, style: 'Italic', chinese: false })
    // Hidden system faces are skipped.
    expect(faceNames(nameTable([[3, EN, 1, '.SF NS']]), null)).toBeNull()
  })

  it('reads single fonts and collections from disk and groups faces into families', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fonts-'))
    roots.push(root)
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'georgia.ttf'), face(0, [[3, EN, 1, 'Georgia'], [3, EN, 2, 'Regular']]))
    // A collection: header, two offsets, then two faces.
    const first = face(20, [[3, EN, 1, 'SimSun'], [3, ZH, 1, '宋体'], [3, EN, 2, 'Regular']], CHINESE_CODE_PAGE)
    const second = face(20 + first.length, [[3, EN, 1, 'NSimSun'], [3, ZH, 1, '新宋体'], [3, EN, 2, 'Regular']], CHINESE_CODE_PAGE)
    const header = Buffer.alloc(20)
    header.write('ttcf', 0, 'latin1')
    header.writeUInt32BE(0x00010000, 4)
    header.writeUInt32BE(2, 8)
    header.writeUInt32BE(20, 12)
    header.writeUInt32BE(20 + first.length, 16)
    await writeFile(join(root, 'nested', 'simsun.ttc'), Buffer.concat([header, first, second]))
    await writeFile(join(root, 'georgia-bold.otf'), face(0, [[3, EN, 1, 'Georgia'], [3, EN, 2, 'Bold']]))
    await writeFile(join(root, 'broken.ttf'), Buffer.from('not a font'))
    await writeFile(join(root, 'readme.txt'), 'ignored')

    expect((await readFontFile(join(root, 'nested', 'simsun.ttc'))).map((entry) => entry.localName)).toEqual(['宋体', '新宋体'])
    expect(await readFontFile(join(root, 'broken.ttf'))).toEqual([])
    const fonts = await new LocalFontCatalog(() => [root, join(root, 'missing')]).list()
    expect(fonts).toEqual([
      { family: 'Georgia', localName: null, styles: ['Bold', 'Regular'], chinese: false },
      { family: 'NSimSun', localName: '新宋体', styles: ['Regular'], chinese: true },
      { family: 'SimSun', localName: '宋体', styles: ['Regular'], chinese: true }
    ])

    // Lookup by either name, search with Chinese fonts first.
    expect(findLocalFont(fonts, '宋体')?.family).toBe('SimSun')
    expect(findLocalFont(fonts, 'georgia')?.family).toBe('Georgia')
    expect(findLocalFont(fonts, 'Arial')).toBeNull()
    // Chinese labels sort by pinyin: 宋体 before 新宋体.
    expect(searchLocalFonts(fonts, 'sim').map((font) => font.family)).toEqual(['SimSun', 'NSimSun'])
    expect(searchLocalFonts(fonts, '').map(fontLabel)).toEqual(['宋体 (SimSun)', '新宋体 (NSimSun)', 'Georgia'])
  })

  it('merges faces of one family and looks in each system folder', () => {
    expect(groupFontFaces([
      { family: 'Inter', localName: null, style: 'Bold', chinese: false },
      { family: 'inter', localName: null, style: 'Regular', chinese: false }
    ])).toEqual([{ family: 'Inter', localName: null, styles: ['Bold', 'Regular'], chinese: false }])
    expect(systemFontDirectories('win32', { WINDIR: 'D:\\Win', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }))
      .toEqual([join('D:\\Win', 'Fonts'), join('C:\\Users\\a\\AppData\\Local', 'Microsoft', 'Windows', 'Fonts')])
    expect(systemFontDirectories('darwin', {})).toContain('/Library/Fonts')
  })
})
