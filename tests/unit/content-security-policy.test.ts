import { describe, expect, it } from 'vitest'
import { rendererContentSecurityPolicy } from '../../src/main/security/content-security-policy'

describe('renderer content security policy', () => {
  it('allows only the Vite development preamble to use inline scripts', () => {
    const policy = rendererContentSecurityPolicy('http://localhost:5173/')
    expect(policy).toContain("script-src 'self' 'unsafe-inline'")
    expect(policy).toContain("connect-src 'self' ws: wss:")
    expect(policy).toContain("frame-ancestors 'none'")
  })

  it('keeps production scripts self-only for missing or empty renderer URLs', () => {
    for (const rendererUrl of [undefined, '']) {
      const policy = rendererContentSecurityPolicy(rendererUrl)
      expect(policy).toContain("script-src 'self'")
      expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")
      expect(policy).toContain("object-src 'none'")
    }
  })
})
