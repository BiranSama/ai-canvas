import { describe, expect, it, vi } from 'vitest'
import { ArkHttpClient, providerHttpCodeForStatus } from '../../src/main/security/ark-http-client'
import { agentErrorRecipe } from '../../src/shared/agent-recovery'

describe('image Provider content policy rejection', () => {
  it.each(['OutputImageSensitiveContentDetected', 'InputImageSensitiveContentDetected', 'InputTextSensitiveContentDetected'])('classifies %s without replaying the request or leaking raw text', async (code) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code, message: 'provider-private-text Request id: private-request-id' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
    const client = new ArkHttpClient({ secrets: { get: async () => 'fixture-key' }, authorization: { reserve: async () => undefined }, allowedBaseUrls: ['https://images.example.test/v1'], fetcher })
    await expect(client.postJson({ url: 'https://images.example.test/v1/images/generations', body: {}, secretId: 'image-provider', expectedImages: 1, costCeilingCny: 0, timeoutMs: 1000, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'PROVIDER_CONTENT_FILTERED', message: '图片服务的内容审核未通过，本次没有返回图片。请检查创作内容和参考图；应用不会自动重复提交。' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(agentErrorRecipe('PROVIDER_CONTENT_FILTERED')).toMatchObject({ defaultRetryClass: 'user_action_required', defaultExternalState: 'known_failed', maxAutomaticModelRepairs: 0, maxAutomaticLocalRetries: 0 })
  })

  it('does not infer policy filtering from arbitrary error text or an auth failure', () => {
    expect(providerHttpCodeForStatus(403, { error: { code: 'AccessDenied', message: 'sensitive information' } })).toBe('PROVIDER_AUTH_FAILED')
    expect(providerHttpCodeForStatus(400, { error: { code: 'OtherError' } })).toBe('PROVIDER_HTTP_ERROR')
  })
})
