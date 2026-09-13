import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DiagnosticExportService,
  MAX_DIAGNOSTIC_EXPORT_BYTES,
  type DiagnosticExportSourceSnapshot
} from '../../src/main/diagnostics/diagnostic-export-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function source(): DiagnosticExportSourceSnapshot {
  return {
    runtime: {
      appVersion: '1.0.0', electronVersion: '43.3.0', platform: 'win32',
      nativeModules: { betterSqlite3: true, sharp: true, sqliteVersion: '3.51.2', sharpVersion: '0.35.3' }
    },
    appearance: {
      settings: {
        schemaVersion: 1, theme: 'pearl', glassMaterial: 'crystal', opticalQuality: 'balanced',
        motion: 'system', sceneReflection: 'artwork', updatedAt: '2026-09-01T00:00:00.000Z'
      },
      effectiveTheme: 'pearl'
    },
    providers: [{
      id: 'image-provider', kind: 'image', protocol: 'openai-images', configured: true,
      capabilities: { textToImage: true, imageReferences: true, maskEditing: true, multipleReferences: true, transparentOutput: false }
    }],
    executionPolicy: {
      approvalMode: 'confirm_each', autoGenerate: false,
      maxRequestsPerJob: 5, maxImagesPerJob: 4, maxCostCnyPerJob: 3
    },
    usage: [{
      scopeId: 'private-job-id', providerId: 'image-provider', requests: 1,
      images: 1, reservedCostCny: 0.22, updatedAt: '2026-09-01T01:00:00.000Z'
    }],
    project: {
      projectId: '00000000-0000-4000-8000-000000000123', schemaVersion: 3, sceneRevision: 9,
      elementCount: 4, jobCount: 2, resultCount: 3, recovered: false,
      recoveredFromOlderSnapshot: false, migration: { fromVersion: 9, toVersion: 10 }
    }
  }
}

describe('Diagnostic Export v1', () => {
  it('exports a bounded seven-day package with no credentials, prompts, paths, image bytes or signed URLs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-diagnostic-export-'))
    roots.push(root)
    const logPath = join(root, 'logs', 'diagnostic.jsonl')
    const outputPath = join(root, 'AI-Canvas-diagnostics.json')
    const currentAt = new Date('2026-09-01T12:00:00.000Z')
    const recent = Array.from({ length: 520 }, (_, index) => JSON.stringify({
      level: 'error', correlationId: `correlation-${index}`, event: 'provider.failed',
      details: {
        message: `failed at C:\\Users\\Alice\\Pictures\\secret-${index}.png`,
        authorization: 'Bearer sk-private-secret-123456789',
        prompt: `full private prompt ${index}`,
        imageBytes: `data:image/png;base64,${'A'.repeat(120)}`,
        signedUrl: `https://example.invalid/image.png?X-Amz-Signature=secret-${index}`
      },
      at: new Date(currentAt.getTime() - index * 1_000).toISOString()
    }))
    recent.push(JSON.stringify({
      level: 'info', correlationId: '71000000-0000-4000-8000-000000000701', event: 'provider.attempt.headers',
      details: {
        schemaVersion: 1,
        attemptId: '72000000-0000-4000-8000-000000000702',
        requestCorrelationId: '71000000-0000-4000-8000-000000000701',
        providerId: 'openai-compatible-llm', providerLabel: 'Fixture', protocol: 'openai-responses',
        model: 'fixture-model', transportMode: 'stream', phase: 'headers', elapsedMs: 41,
        receivedBytes: 0, recognizedEventCount: 0, httpStatus: 200,
        authorization: 'Bearer must-not-export', prompt: 'must-not-export'
      },
      at: currentAt.toISOString()
    }))
    recent.push(JSON.stringify({
      level: 'warn', correlationId: '71000000-0000-4000-8000-000000000701', event: 'recovery.started',
      details: {
        schemaVersion: 1, failureId: '73000000-0000-4000-8000-000000000703',
        fingerprint: '0123456789abcdef', attempt: 1, maxAttempts: 2,
        failureCode: 'MODEL_PLAN_SCHEMA_INVALID',
        failure: { phase: 'validation', category: 'schema', retryClass: 'model_can_repair', replacementScope: 'single_tool' }
      },
      at: currentAt.toISOString()
    }))
    recent.push(JSON.stringify({
      level: 'warn', correlationId: 'old-record', event: 'old.event', details: { message: 'too old' },
      at: '2026-08-01T00:00:00.000Z'
    }))
    await mkdir(join(root, 'logs'), { recursive: true })
    await writeFile(logPath, `${recent.join('\n')}\n`, 'utf8')

    const service = new DiagnosticExportService({ logFilePath: logPath, now: () => currentAt })
    const receipt = await service.exportTo(outputPath, source())
    const raw = await readFile(outputPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      readonly diagnostics: { readonly retained: number }
      readonly project: { readonly idHash: string }
      readonly usage: readonly { readonly scopeIdHash: string }[]
    }

    expect(receipt).toMatchObject({ recordCount: 500 })
    expect((await stat(outputPath)).size).toBeLessThanOrEqual(MAX_DIAGNOSTIC_EXPORT_BYTES)
    expect(parsed).toMatchObject({ schemaVersion: 1, diagnostics: { retained: 500 } })
    expect(parsed.project.idHash).not.toContain('00000000-0000-4000-8000-000000000123')
    expect(parsed.usage[0]?.scopeIdHash).not.toBe('private-job-id')
    expect(raw).toContain('provider.attempt.headers')
    expect(raw).toContain('recovery.started')
    expect(raw).toContain('MODEL_PLAN_SCHEMA_INVALID')
    expect(raw).not.toMatch(/sk-private|full private prompt|Alice|data:image|X-Amz-Signature|example\.invalid|private-job-id/)
    expect(raw).not.toContain('must-not-export')
    expect(raw).not.toContain('old-record')
  })

  it('removes the oldest records until an unusually dense package fits the 2 MiB hard limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-diagnostic-size-limit-'))
    roots.push(root)
    const logPath = join(root, 'diagnostic.jsonl')
    const outputPath = join(root, 'bounded.json')
    const currentAt = new Date('2026-09-01T12:00:00.000Z')
    const denseDetails = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
      `safeField${index}`,
      `diagnostic-${index}-${'诊'.repeat(1_980)}`
    ]))
    const lines = Array.from({ length: 80 }, (_, index) => JSON.stringify({
      level: 'warn', correlationId: `dense-${index}`, event: 'dense.event', details: denseDetails,
      at: new Date(currentAt.getTime() - index * 1_000).toISOString()
    }))
    await writeFile(logPath, `${lines.join('\n')}\n`, 'utf8')

    const service = new DiagnosticExportService({ logFilePath: logPath, now: () => currentAt })
    const receipt = await service.exportTo(outputPath, source())
    const exported = JSON.parse(await readFile(outputPath, 'utf8')) as {
      readonly diagnostics: { readonly retained: number }
      readonly truncationSummary: { readonly recordsRemovedForSize: number; readonly truncatedForSize: boolean }
    }

    expect(receipt.truncated).toBe(true)
    expect(receipt.bytes).toBeLessThanOrEqual(MAX_DIAGNOSTIC_EXPORT_BYTES)
    expect(exported.diagnostics.retained).toBeLessThan(80)
    expect(exported.truncationSummary).toMatchObject({ truncatedForSize: true })
    expect(exported.truncationSummary.recordsRemovedForSize).toBeGreaterThan(0)
  })
})
