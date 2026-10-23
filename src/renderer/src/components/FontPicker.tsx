import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, RotateCw } from 'lucide-react'
import { findLocalFont, fontLabel, searchLocalFonts, type LocalFontFamily } from '../../../shared/local-fonts'

const RECENT_KEY = 'ai-canvas.recent-fonts'
const MAX_RECENT = 6
const MAX_ROWS = 300

let loaded: Promise<readonly LocalFontFamily[]> | null = null

function loadFonts(rescan = false): Promise<readonly LocalFontFamily[]> {
  if (loaded === null || rescan) {
    // A missing bridge (older preload, tests) reads as no fonts, and the field still takes any name.
    loaded = Promise.resolve().then(() => window.desktop.listLocalFonts(rescan)).catch(() => {
      loaded = null
      return []
    })
  }
  return loaded
}

function readRecent(): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

function rememberRecent(family: string): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([family, ...readRecent().filter((entry) => entry !== family)].slice(0, MAX_RECENT)))
  } catch {
    // Recent fonts are a convenience; without storage the list simply stays empty.
  }
}

/** Quotes a family for CSS so names with spaces or digits preview correctly. */
function cssFamily(family: string): string {
  return `"${family.replaceAll('"', '')}", sans-serif`
}

interface Row {
  readonly key: string
  readonly family: string
  readonly label: string
  readonly secondary: string | null
  readonly section: string
}

/** Lists the fonts installed on this computer, each shown in its own face, with search and recent picks. */
export function FontPicker({ value, onChange }: { readonly value: string; readonly onChange: (family: string) => void }) {
  const [fonts, setFonts] = useState<readonly LocalFontFamily[] | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState<readonly string[]>(() => readRecent())
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current = true
    void loadFonts().then((list) => { if (current) setFonts(list) })
    return () => { current = false }
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  const current = fonts === null ? null : findLocalFont(fonts, value)
  const missing = fonts !== null && fonts.length > 0 && current === null

  const rows = useMemo((): readonly Row[] => {
    if (fonts === null) return []
    const toRow = (font: LocalFontFamily, section: string): Row => ({
      key: `${section}:${font.family}`,
      family: font.family,
      label: font.localName ?? font.family,
      secondary: font.localName === null ? null : font.family,
      section
    })
    const matches = searchLocalFonts(fonts, query, MAX_ROWS)
    const recentRows = query.trim() === ''
      ? recent.flatMap((family) => {
          const font = findLocalFont(fonts, family)
          return font === null ? [] : [toRow(font, '最近使用')]
        })
      : []
    const typed = query.trim()
    const custom = typed !== '' && findLocalFont(fonts, typed) === null
      ? [{ key: `custom:${typed}`, family: typed, label: `使用「${typed}」`, secondary: '这台电脑上没有装这个字体', section: '其他名称' }]
      : []
    return [
      ...recentRows,
      ...matches.map((font) => toRow(font, font.chinese ? '中文字体' : '其他字体')),
      ...custom
    ]
  }, [fonts, query, recent])

  useEffect(() => {
    if (!open) return
    // jsdom has no scrollIntoView.
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open])

  const choose = (family: string): void => {
    onChange(family)
    rememberRecent(family)
    setRecent(readRecent())
    setOpen(false)
    setQuery('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => Math.min(rows.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => Math.max(0, index - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const row = rows[active]
      if (row !== undefined) choose(row.family)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div className="font-picker" ref={rootRef}>
      <button
        type="button"
        className={`font-picker-trigger${missing ? ' is-missing' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`字体：${current === null ? value : fontLabel(current)}`}
        onClick={() => { setOpen((wasOpen) => !wasOpen); setActive(0) }}
      >
        <span style={{ fontFamily: cssFamily(value) }}>{current?.localName ?? value}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {missing && <p className="font-picker-note">这台电脑上没有这个字体，画布会用相近的字体代替。</p>}
      {open && (
        <div className="font-picker-popover" role="dialog" aria-label="选择字体">
          <input
            autoFocus
            aria-label="搜索字体"
            placeholder="搜索中文名或英文名"
            value={query}
            onChange={(event) => { setQuery(event.currentTarget.value); setActive(0) }}
            onKeyDown={onKeyDown}
          />
          <div className="font-picker-list" role="listbox" ref={listRef} aria-label="字体">
            {fonts === null && <p className="font-picker-empty">正在读取本机字体…</p>}
            {fonts !== null && rows.length === 0 && <p className="font-picker-empty">没有找到字体。</p>}
            {rows.map((row, index) => (
              <div key={row.key}>
                {(index === 0 || rows[index - 1]!.section !== row.section) && <p className="font-picker-section">{row.section}</p>}
                <button
                  type="button"
                  role="option"
                  aria-selected={row.family === current?.family || row.family === value}
                  data-active={index === active}
                  className="font-picker-option"
                  onPointerEnter={() => setActive(index)}
                  onClick={() => choose(row.family)}
                >
                  <span style={row.section === '其他名称' ? undefined : { fontFamily: cssFamily(row.family) }}>{row.label}</span>
                  {row.secondary !== null && <small>{row.secondary}</small>}
                </button>
              </div>
            ))}
          </div>
          <footer>
            <span>{fonts === null ? '' : `本机 ${fonts.length} 个字体`}</span>
            <button type="button" onClick={() => { setFonts(null); void loadFonts(true).then(setFonts) }}>
              <RotateCw size={11} aria-hidden="true" />重新扫描
            </button>
          </footer>
        </div>
      )}
    </div>
  )
}
