import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { FontPicker } from '../../src/renderer/src/components/FontPicker'

const FONTS = [
  { family: 'Georgia', localName: null, styles: ['Regular'], chinese: false },
  { family: 'Microsoft YaHei', localName: '微软雅黑', styles: ['Regular', 'Bold'], chinese: true },
  { family: 'SimSun', localName: '宋体', styles: ['Regular'], chinese: true }
]
const listLocalFonts = vi.fn(async () => FONTS)

beforeAll(() => {
  Object.defineProperty(window, 'desktop', { configurable: true, value: { listLocalFonts } })
})
afterEach(() => {
  window.localStorage.clear()
})

it('picks an installed font by its Chinese name and remembers it as recent', async () => {
  const onChange = vi.fn()
  render(<FontPicker value="Georgia" onChange={onChange} />)
  await act(async () => undefined)
  expect(screen.queryByText(/没有这个字体/)).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '字体：Georgia' }))
  // Chinese fonts come first, each with its English name beside it.
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['宋体SimSun', '微软雅黑Microsoft YaHei', 'Georgia'])
  fireEvent.change(screen.getByRole('textbox', { name: '搜索字体' }), { target: { value: '雅黑' } })
  fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索字体' }), { key: 'Enter' })
  expect(onChange).toHaveBeenCalledWith('Microsoft YaHei')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '字体：Georgia' }))
  expect(screen.getByText('最近使用')).toBeInTheDocument()
  expect(screen.getAllByRole('option')[0]?.textContent).toBe('微软雅黑Microsoft YaHei')
})

it('warns about a font the computer lacks and still takes a typed name', async () => {
  const onChange = vi.fn()
  render(<FontPicker value="Segoe UI Variable" onChange={onChange} />)
  await act(async () => undefined)
  expect(screen.getByText('这台电脑上没有这个字体，画布会用相近的字体代替。')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '字体：Segoe UI Variable' }))
  fireEvent.change(screen.getByRole('textbox', { name: '搜索字体' }), { target: { value: 'Futura' } })
  fireEvent.click(screen.getByRole('option', { name: /使用「Futura」/ }))
  expect(onChange).toHaveBeenCalledWith('Futura')
})
