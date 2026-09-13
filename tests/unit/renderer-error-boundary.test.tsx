import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RendererErrorBoundary } from '../../src/renderer/src/components/RendererErrorBoundary'

function BrokenWorkspace(): never {
  throw new Error('synthetic renderer failure')
}

describe('RendererErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps an unexpected renderer failure from becoming a blank window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(
      <RendererErrorBoundary>
        <BrokenWorkspace />
      </RendererErrorBoundary>
    )

    expect(screen.getByRole('alert')).toHaveTextContent('界面遇到了一点问题')
    expect(screen.getByRole('button', { name: '重新载入工作台' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('不会自动发起生成、重试任务或增加费用')
  })
})
