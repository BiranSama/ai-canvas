import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ConversationView } from '../../src/renderer/src/components/ConversationView'
import { useCreationSessionStore } from '../../src/renderer/src/store/creation-session-store'

vi.mock('../../src/renderer/src/canvas/CanvasStage', () => ({ CanvasStage: () => <div /> }))

it('acknowledges locally before context IPC settles and ignores a duplicate send', async () => {
  let rejectContext!: (error: Error) => void
  const jobs = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectContext = reject }))
  Object.defineProperty(window, 'desktop', { configurable: true, value: { listGenerationJobs: jobs } })
  render(<ConversationView Header={() => null} onShowLibrary={() => undefined} />)
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

it('holds a message while attached pictures are still being added, and sends them with it', async () => {
  let finishImport!: () => void
  const importAsset = vi.fn(() => new Promise((resolve) => {
    finishImport = () => resolve({ id: '62000000-0000-4000-8000-000000000001', width: 10, height: 10, format: 'png', hasAlpha: false })
  }))
  const jobs = vi.fn(async () => [])
  const startAgentRun = vi.fn(async () => ({ id: 'run-1' }))
  Object.defineProperty(window, 'desktop', { configurable: true, value: { listGenerationJobs: jobs, importAsset, startAgentRun } })
  useCreationSessionStore.setState({ references: [], pendingReferences: 0 })
  const first = render(<ConversationView Header={() => null} onShowLibrary={() => undefined} />)
  const picker = first.container.querySelector<HTMLInputElement>('.conversation-input-row input[type="file"]')!
  const picture = new File([new Uint8Array([1, 2, 3])], '参考.png', { type: 'image/png' })
  await act(async () => { fireEvent.change(picker, { target: { files: [picture] } }) })
  const input = screen.getByRole('textbox', { name: '对话输入' })
  fireEvent.change(input, { target: { value: '照这张图的配色来' } })
  const send = screen.getByRole('button', { name: '发送要求' })
  expect(send).toBeDisabled()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(jobs).not.toHaveBeenCalled()

  // Leaving 对话 for another view and coming back keeps the picture being added, and then the added one.
  first.unmount()
  render(<ConversationView Header={() => null} onShowLibrary={() => undefined} />)
  expect(screen.getByRole('button', { name: '发送要求' })).toBeDisabled()
  await act(async () => { finishImport() })
  expect(screen.getByRole('group', { name: '附件' })).toHaveTextContent('参考.png')
  fireEvent.change(screen.getByRole('textbox', { name: '对话输入' }), { target: { value: '照这张图的配色来' } })
  const sendAgain = screen.getByRole('button', { name: '发送要求' })
  expect(sendAgain).toBeEnabled()
  await act(async () => { fireEvent.click(sendAgain) })
  expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
    attachments: expect.arrayContaining([expect.objectContaining({ kind: 'asset', id: '62000000-0000-4000-8000-000000000001' })])
  }), 'collaboration', 'new_task')
})
