import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImeSafeInput, ImeSafeTextarea } from '../../src/renderer/src/components/ImeSafeTextField'

describe('IME-safe Inspector text fields', () => {
  afterEach(() => vi.useRealTimers())

  it('leaves candidate Escape and Windows IME Enter to the input method', () => {
    const commit = vi.fn(), escape = vi.fn(), key = vi.fn()
    render(<ImeSafeInput aria-label="候选词" value="" onCommit={commit} onEscape={escape} onKeyDown={key} commitDelayMs={null} commitOnEnter />)
    const field = screen.getByRole('textbox', { name: '候选词' })
    fireEvent.focus(field)
    fireEvent.compositionStart(field)
    fireEvent.change(field, { target: { value: 'shan' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field).toHaveValue('shan')
    expect(escape).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: '山' } })
    fireEvent.compositionEnd(field)
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    expect(commit).not.toHaveBeenCalled()
    expect(key).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(commit).toHaveBeenCalledExactlyOnceWith('山')
  })

  it('keeps composition local and commits once after composition ends', () => {
    vi.useFakeTimers()
    const commit = vi.fn()
    render(<ImeSafeTextarea aria-label="文字内容" value="" onCommit={commit} />)
    const field = screen.getByRole('textbox', { name: '文字内容' })

    fireEvent.focus(field)
    fireEvent.compositionStart(field)
    fireEvent.change(field, { target: { value: 'shanhai' } })
    act(() => vi.advanceTimersByTime(1_000))
    expect(commit).not.toHaveBeenCalled()
    expect(field).toHaveValue('shanhai')

    fireEvent.change(field, { target: { value: '山海' } })
    fireEvent.compositionEnd(field, { data: '山海' })
    act(() => vi.advanceTimersByTime(319))
    expect(commit).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenLastCalledWith('山海')
  })

  it('does not treat Enter used by the IME as a rename confirmation', () => {
    const commit = vi.fn()
    render(<ImeSafeInput aria-label="重命名图层" value="标题" onCommit={commit} commitDelayMs={null} commitOnEnter />)
    const field = screen.getByRole('textbox', { name: '重命名图层' })

    fireEvent.focus(field)
    fireEvent.compositionStart(field)
    fireEvent.change(field, { target: { value: '标题层' } })
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    expect(commit).not.toHaveBeenCalled()

    fireEvent.compositionEnd(field, { data: '层' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('标题层')
  })

  it('commits on blur and reverts an uncommitted draft with Escape', () => {
    const commit = vi.fn()
    const escape = vi.fn()
    render(<ImeSafeInput aria-label="风格描述" value="克制" onCommit={commit} commitDelayMs={null} onEscape={escape} />)
    const field = screen.getByRole('textbox', { name: '风格描述' })

    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '轻盈、克制' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field).toHaveValue('克制')
    expect(escape).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: '轻盈、飘逸' } })
    fireEvent.blur(field)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('轻盈、飘逸')
  })
})
