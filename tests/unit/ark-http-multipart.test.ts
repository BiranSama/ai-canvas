import { describe, expect, it, vi } from 'vitest'
import { ArkHttpClient } from '../../src/main/security/ark-http-client'

describe('Main-only multipart Provider transport', () => {
  it('accepts an exact saved operation endpoint, reserves before fetch and lets FormData set its boundary', async () => {
    const reserve = vi.fn(async () => undefined)
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://images.example.test/v1/images/edits')
      expect(init?.headers).toEqual({ authorization: 'Bearer synthetic-image-key' })
      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      expect(form.get('model')).toBe('owner-image')
      expect(form.getAll('image[]')).toHaveLength(1)
      return new Response(JSON.stringify({ data: [{ b64_json: 'ZmFrZQ==' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const client = new ArkHttpClient({
      secrets: { get: async () => 'synthetic-image-key' },
      authorization: { reserve },
      allowedBaseUrls: [
        'https://images.example.test/v1/images/generations',
        'https://images.example.test/v1/images/edits'
      ],
      fetcher
    })

    await expect(client.postMultipart({
      url: 'https://images.example.test/v1/images/edits',
      fields: { model: 'owner-image', prompt: 'fixture', n: '1' },
      files: [{
        field: 'image[]',
        name: 'reference.png',
        mimeType: 'image/png',
        bytes: Buffer.from('fixture-image')
      }],
      secretId: 'image-provider',
      providerId: 'image-provider',
      providerLabel: 'Owner Image Relay',
      authorizationScopeId: 'image-job:test',
      expectedImages: 1,
      costCeilingCny: 3,
      signal: new AbortController().signal,
      timeoutMs: 30_000
    })).resolves.toEqual({ data: [{ b64_json: 'ZmFrZQ==' }] })

    expect(reserve).toHaveBeenCalledWith({
      scopeId: 'image-job:test',
      providerId: 'image-provider',
      requests: 1,
      images: 1,
      costCeilingCny: 3
    })
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0]!)
  })

  it('rejects a sibling path that only shares the approved path prefix', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new ArkHttpClient({
      secrets: { get: async () => 'synthetic-image-key' },
      authorization: { reserve: async () => undefined },
      allowedBaseUrls: ['https://images.example.test/v1/images/edits'],
      fetcher
    })

    await expect(client.postMultipart({
      url: 'https://images.example.test/v1/images/edits-malicious',
      fields: {},
      files: [{
        field: 'image[]',
        name: 'reference.png',
        mimeType: 'image/png',
        bytes: Buffer.from('fixture-image')
      }],
      secretId: 'image-provider',
      expectedImages: 1,
      costCeilingCny: 3,
      signal: new AbortController().signal,
      timeoutMs: 30_000
    })).rejects.toMatchObject({ code: 'PROVIDER_DESTINATION_DENIED' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
