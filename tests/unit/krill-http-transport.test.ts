import { describe, expect, it, vi } from 'vitest'
import { KrillHttpTransport } from '../../src/main/security/krill-http-transport'

describe('Krill Main-only HTTP transport', () => {
  it('requires persistent authorization before a pinned request and keeps credentials out of protocol data', async () => {
    const reserve = vi.fn(async () => undefined)
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toMatchObject({
        'content-type': 'application/json',
        authorization: 'Bearer synthetic-krill-key'
      })
      return new Response(JSON.stringify({ id: 'task-1', status: 'queued' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const transport = new KrillHttpTransport({
      secrets: { get: async () => 'synthetic-krill-key' },
      authorization: { reserve },
      fetcher
    })
    const request = {
      url: 'https://api.krill-ai.net/v1/images/generations',
      body: { model: 'qwen-image-2.0', prompt: 'fixture', async: true, n: 1 }
    }
    expect(JSON.stringify(request)).not.toContain('synthetic-krill-key')
    await expect(transport.postJson(request, new AbortController().signal)).resolves.toEqual({ id: 'task-1', status: 'queued' })
    expect(reserve).toHaveBeenCalledWith({
      operation: 'submit',
      scopeId: 'krill-provider',
      providerId: 'image-provider',
      requests: 1,
      expectedImages: 1,
      costCeilingCny: 2
    })
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0]!)
  })

  it('rejects unapproved destinations, missing keys and downloads with non-image content', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const transport = new KrillHttpTransport({
      secrets: { get: async () => 'synthetic-krill-key' },
      authorization: { reserve: async () => undefined },
      fetcher
    })
    await expect(transport.getJson({ url: 'https://example.test/v1/models' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'KRILL_DESTINATION_DENIED' })
    expect(fetcher).not.toHaveBeenCalled()

    const missing = new KrillHttpTransport({
      secrets: { get: async () => null },
      authorization: { reserve: async () => { throw new Error('must not reserve without a key') } },
      fetcher
    })
    await expect(missing.getJson({ url: 'https://api.krill-ai.net/v1/models' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'KRILL_KEY_MISSING' })

    const textTransport = new KrillHttpTransport({
      secrets: { get: async () => 'synthetic-krill-key' },
      authorization: { reserve: async () => undefined },
      fetcher: vi.fn(async () => new Response('not an image', {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      }))
    })
    await expect(textTransport.getImage({
      url: 'https://api.krill-ai.net/v1/images/task-1/content'
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'KRILL_IMAGE_TYPE' })
  })

  it('pins a user-configured asynchronous Images base URL without using a model catalog', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toBe('https://tasks.example.test/api/v1/images/generations')
      return new Response(JSON.stringify({ id: 'task-owner-1', status: 'queued' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const reserve = vi.fn(async () => undefined)
    const transport = new KrillHttpTransport({
      secrets: { get: async () => 'synthetic-owner-key' },
      authorization: { reserve },
      baseUrl: 'https://tasks.example.test/api/v1',
      submissionCostCeilingCny: 3,
      fetcher
    })
    await expect(transport.postJson({
      url: 'https://tasks.example.test/api/v1/images/generations',
      body: { model: 'owner-model', prompt: 'fixture', async: true, n: 1 }
    }, new AbortController().signal)).resolves.toMatchObject({ id: 'task-owner-1' })
    await expect(transport.getJson({
      url: 'https://other.example.test/api/v1/images/task-owner-1'
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'KRILL_DESTINATION_DENIED' })
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ costCeilingCny: 3 }))
  })

  it('retries only idempotent transient reads, reserves every GET, and never reposts a submission', async () => {
    const reserve = vi.fn(async () => undefined)
    const readFetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'temporary' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      }))
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'task-1', status: 'running' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }))
    const readTransport = new KrillHttpTransport({
      secrets: { get: async () => 'synthetic-key' },
      authorization: { reserve },
      fetcher: readFetcher
    })

    await expect(readTransport.getJson({
      url: 'https://api.krill-ai.net/v1/images/task-1',
      authorizationScopeId: 'task-1'
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'running' })
    expect(readFetcher).toHaveBeenCalledTimes(3)
    expect(reserve).toHaveBeenCalledTimes(3)
    expect(reserve).toHaveBeenNthCalledWith(3, expect.objectContaining({ operation: 'poll', requests: 1 }))

    const postFetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: 'temporary' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    }))
    const postTransport = new KrillHttpTransport({
      secrets: { get: async () => 'synthetic-key' },
      authorization: { reserve: async () => undefined },
      fetcher: postFetcher
    })
    await expect(postTransport.postJson({
      url: 'https://api.krill-ai.net/v1/images/generations',
      body: { model: 'qwen-image-2.0', prompt: 'fixture', async: true, n: 1 }
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'KRILL_HTTP_ERROR', status: 503 })
    expect(postFetcher).toHaveBeenCalledTimes(1)
  })
})
