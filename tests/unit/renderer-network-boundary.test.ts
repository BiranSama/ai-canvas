import { describe, expect, it } from 'vitest'
import { isRendererNetworkRequestAllowed, rendererLoadRecoveryDataUrl } from '../../src/main/window'

describe('AH1 renderer zero-network boundary', () => {
  it('blocks every production HTTP(S) request including Chromium dictionary downloads', () => {
    expect(isRendererNetworkRequestAllowed('https://redirector.gvt1.com/edgedl/chrome/dict/en-us.bdic', undefined)).toBe(false)
    expect(isRendererNetworkRequestAllowed('https://api.krill-ai.net/v1/images/generations', '')).toBe(false)
  })

  it('allows only the configured Vite origin during local development', () => {
    expect(isRendererNetworkRequestAllowed('http://localhost:5173/src/main.tsx', 'http://localhost:5173/')).toBe(true)
    expect(isRendererNetworkRequestAllowed('ws://localhost:5173/', 'http://localhost:5173/')).toBe(false)
    expect(isRendererNetworkRequestAllowed('https://example.com/asset.png', 'http://localhost:5173/')).toBe(false)
  })

  it('provides a local, redacted recovery document when renderer assets cannot load', () => {
    const url = rendererLoadRecoveryDataUrl()
    expect(url).toMatch(/^data:text\/html/)
    const document = decodeURIComponent(url.slice(url.indexOf(',') + 1))
    expect(document).toContain('界面资源暂时没有载入')
    expect(document).toContain('不会自动发起生成、重试模型请求或增加费用')
    expect(document).not.toMatch(/https?:\/\//)
    expect(document).not.toContain('errorDescription')
  })
})
