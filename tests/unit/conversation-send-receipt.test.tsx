import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ConversationView } from '../../src/renderer/src/components/ConversationView'

vi.mock('../../src/renderer/src/canvas/CanvasStage', () => ({ CanvasStage: () => <div /> }))

it('acknowledges locally before context IPC settles and ignores a duplicate send', async () => {
  let rejectContext!: (error: Error) => void
  const jobs = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectContext = reject }))
  Object.defineProperty(window, 'desktop', { configurable: true, value: { listGenerationJobs: jobs } })
  render(<ConversationView header={null} />)
  const input = screen.getByRole('textbox', { name: '对话输入' })
  fireEvent.compositionStart(input)
  fireEvent.change(input, { target: { value: '建立一个安静的构图' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: false })
  expect(jobs).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
  expect(jobs).not.toHaveBeenCalled()
  const send = screen.getByRole('button', { name: '发送要求' })
  fireEvent.click(send)
  expect(screen.getByRole('status')).toHaveTextContent('已接收要求')
  expect(send).toBeDisabled()
  fireEvent.click(send)
  expect(jobs).toHaveBeenCalledTimes(1)
  await act(async () => { rejectContext(new Error('fixture context unavailable')) })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '对话输入' })).toHaveValue('建立一个安静的构图')
})
