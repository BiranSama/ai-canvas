import { createScene } from '../../src/domain'
import { DEFAULT_PROVIDER_CONFIG } from '../../src/shared/provider-settings'
import { createNightVeilScene, NIGHT_VEIL_IDS } from '../../src/renderer/src/fixtures/night-veil'

const EMPTY_PROJECT_ID = '30000000-0000-4000-8000-000000000001'
const EMPTY_SCENE_ID = '30000000-0000-4000-8000-000000000002'
const FIXED_NOW = '2026-08-10T00:00:00.000Z'

export const HANDOFF_FIXTURE_IDS = [
  'project.recent',
  'canvas.empty',
  'canvas.nightVeil',
  'canvas.textSelected',
  'conversation.layoutCreated',
  'composer.allStates',
  'generation.progress',
  'generation.results',
  'generation.failed',
  'provider.settings',
  'asset.missing'
] as const

export const HANDOFF_FIXTURES = {
  'project.recent': {
    id: EMPTY_PROJECT_ID,
    name: 'Night Veil',
    lastOpenedAt: FIXED_NOW
  },
  'canvas.empty': createScene({ id: EMPTY_SCENE_ID, projectId: EMPTY_PROJECT_ID, now: FIXED_NOW }),
  'canvas.nightVeil': createNightVeilScene(),
  'canvas.textSelected': {
    scene: createNightVeilScene(),
    selectedIds: [NIGHT_VEIL_IDS.title]
  },
  'conversation.layoutCreated': {
    request: '创建一张 4:5 的深蓝香水广告海报，标题是 NIGHT VEIL。先不要生成图片。',
    receipt: '布局已创建：4:5 画布、顶部标题、中央偏下香水瓶与背后柔光已经就位。',
    operationCount: 4
  },
  'composer.allStates': [
    'idle', 'editing', 'acting', 'confirm', 'generating', 'completed', 'failed', 'cancelled'
  ],
  'generation.progress': {
    providerId: 'mock',
    model: 'mock-slow',
    status: 'generating',
    stage: 'generating'
  },
  'generation.results': {
    providerId: 'mock',
    model: 'mock-balanced',
    status: 'completed',
    resultCount: 2
  },
  'generation.failed': {
    providerId: 'mock',
    model: 'mock-failure',
    status: 'failed',
    errorCode: 'MOCK_PROVIDER_FAILURE',
    requestPreserved: true
  },
  'provider.settings': {
    config: structuredClone(DEFAULT_PROVIDER_CONFIG),
    secretsConfigured: false,
    realCallsAuthorized: false
  },
  'asset.missing': {
    id: '30000000-0000-4000-8000-000000000003',
    name: 'missing-reference.png',
    status: 'missing',
    canRelinkByContentHash: true
  }
} as const
