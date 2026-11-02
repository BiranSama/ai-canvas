import { ELEMENT_SCHEMA_VERSION, sceneSchema, type Scene, type SceneElement } from '../../../domain'
import { createBlankScene } from '../scene/create-blank-scene'

/**
 * Finished starting points for a small shop: every layer can be changed, and
 * the subject is a placeholder the Agent can generate into. Opened from the
 * project library's 「从示例开始」 and the project menu.
 */
export const MERCHANT_EXAMPLE_KEYS = ['coffee-poster', 'xiaohongshu-cover', 'product-main', 'sale-banner'] as const

export type MerchantExampleKey = typeof MERCHANT_EXAMPLE_KEYS[number]

export interface MerchantExampleInfo {
  readonly label: string
  readonly ratio: string
  readonly note: string
  /** What to try first in the conversation once it is open. */
  readonly prompts: readonly string[]
}

export const MERCHANT_EXAMPLES: Record<MerchantExampleKey, MerchantExampleInfo> = {
  'coffee-poster': { label: '咖啡店海报', ratio: '4:5', note: '新品上市、门店活动', prompts: ['把标题换成我的店名', '换成暖色调', '生成主体图片'] },
  'xiaohongshu-cover': { label: '小红书封面', ratio: '3:4', note: '探店、种草笔记', prompts: ['把标题改成我的笔记标题', '换一种配色', '生成主体图片'] },
  'product-main': { label: '商品主图', ratio: '1:1', note: '电商、外卖平台', prompts: ['把卖点换成我的商品卖点', '价格改成 59 元', '生成主体图片'] },
  'sale-banner': { label: '活动横幅', ratio: '16:9', note: '店铺首页、社群海报', prompts: ['把活动改成周年庆', '换成红色喜庆风格', '生成主体图片'] }
}

interface ExampleOptions {
  readonly projectId?: string
  readonly sceneId?: string
  readonly now?: string
}

type Fixture = { readonly canvas: Scene['canvas']; readonly elements: readonly SceneElement[] }

const FONT = 'Microsoft YaHei UI'

function id(example: number, index: number): string {
  return `3${example}000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function base(elementId: string, type: SceneElement['type'], name: string, zIndex: number, semanticRole: string) {
  return {
    id: elementId, version: ELEMENT_SCHEMA_VERSION, type, name, description: '', zIndex, opacity: 1,
    visible: true, locked: false, groupId: null, semanticRole, referencePolicy: 'include' as const
  }
}

/** cornerRadius is a share of the shorter side, 0 to 0.5. */
function rect(elementId: string, name: string, zIndex: number, semanticRole: string, transform: SceneElement['transform'], fill: string, cornerRadius = 0, shape: 'rectangle' | 'ellipse' = 'rectangle'): SceneElement {
  return { ...base(elementId, 'shape', name, zIndex, semanticRole), type: 'shape', transform, shape, fill, stroke: null, strokeWidth: 0, cornerRadius, role: 'final' } as SceneElement
}

function text(elementId: string, name: string, zIndex: number, semanticRole: string, transform: SceneElement['transform'], content: string, style: {
  readonly size: number; readonly weight?: number; readonly fill: string; readonly align?: 'start' | 'center' | 'end'; readonly spacing?: number; readonly description: string
}): SceneElement {
  return {
    ...base(elementId, 'text', name, zIndex, semanticRole), type: 'text', transform, content,
    orientation: 'horizontal', align: style.align ?? 'start', wrapping: 'word', fontFamily: FONT, fontSize: style.size, fontWeight: style.weight ?? 500,
    fill: style.fill, stroke: null, strokeWidth: 0, shadowColor: null, shadowBlur: 0, letterSpacing: style.spacing ?? 0, lineHeight: 1.2,
    accuracy: 'strict', styleDescription: style.description, renderStrategy: 'standard', resultAssetId: null
  } as SceneElement
}

function subject(elementId: string, name: string, zIndex: number, transform: SceneElement['transform'], what: string, visualKind: 'product' | 'coffee' | 'generic', notes: string): SceneElement {
  return {
    ...base(elementId, 'placeholder', name, zIndex, 'subject'), type: 'placeholder', description: what, transform,
    subject: what, pose: '正面略侧', facing: '朝向观看者', allowOverflow: false, transparentBackground: true,
    frameShape: 'free', visualKind, generationNotes: notes
  } as SceneElement
}

function coffeePoster(): Fixture {
  return {
    canvas: { aspectWidth: 4, aspectHeight: 5, outputWidth: 1024, outputHeight: 1280, backgroundColor: '#EFE4D6', transparent: false, globalStyle: '温暖的咖啡店海报，奶油色背景，柔和自然光，干净留白' },
    elements: [
      rect(id(1, 1), '奶油色背景', 0, 'background', { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, '#EFE4D6'),
      rect(id(1, 2), '底部色块', 1, 'decoration', { x: 0, y: 0.78, width: 1, height: 0.22, rotation: 0 }, '#6B4A35'),
      subject(id(1, 3), '一杯拿铁', 2, { x: 0.22, y: 0.3, width: 0.56, height: 0.52, rotation: 0 }, '一杯带拉花的热拿铁，陶瓷杯', 'coffee', '暖色自然光，杯身干净，背景透明'),
      text(id(1, 4), '标题', 3, 'title', { x: 0.1, y: 0.07, width: 0.8, height: 0.13, rotation: 0 }, '秋日拿铁', { size: 112, weight: 700, fill: '#3E2A1E', align: 'center', spacing: 6, description: '粗黑体大标题，深咖色，稳重醒目' }),
      text(id(1, 5), '副标题', 4, 'subtitle', { x: 0.1, y: 0.2, width: 0.8, height: 0.06, rotation: 0 }, '门店新品 · 第二杯半价', { size: 40, fill: '#6B4A35', align: 'center', spacing: 2, description: '中等字号说明文字，咖啡色' }),
      rect(id(1, 6), '价格圆标', 5, 'badge', { x: 0.7, y: 0.56, width: 0.2, height: 0.16, rotation: 0 }, '#C8553D', 0, 'ellipse'),
      text(id(1, 7), '价格', 6, 'price', { x: 0.7, y: 0.6, width: 0.2, height: 0.08, rotation: 0 }, '¥18', { size: 56, weight: 700, fill: '#FFFFFF', align: 'center', description: '白色粗体价格' }),
      text(id(1, 8), '店名', 7, 'caption', { x: 0.1, y: 0.84, width: 0.8, height: 0.08, rotation: 0 }, '你的咖啡店 · 每天 8:00 – 21:00', { size: 36, fill: '#F5EBDD', align: 'center', spacing: 2, description: '浅色店名与营业时间' })
    ]
  }
}

function xiaohongshuCover(): Fixture {
  return {
    canvas: { aspectWidth: 3, aspectHeight: 4, outputWidth: 1080, outputHeight: 1440, backgroundColor: '#FBEDEA', transparent: false, globalStyle: '小红书种草封面，清新粉色，明亮自然光，生活感' },
    elements: [
      rect(id(2, 1), '浅粉背景', 0, 'background', { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, '#FBEDEA'),
      subject(id(2, 2), '手作甜品', 1, { x: 0.1, y: 0.36, width: 0.8, height: 0.52, rotation: 0 }, '木桌上的几款手作甜品和一杯饮品', 'product', '俯拍，明亮自然光，食物新鲜诱人'),
      rect(id(2, 3), '标题底条', 2, 'decoration', { x: 0.06, y: 0.07, width: 0.88, height: 0.2, rotation: 0 }, '#FFFFFF', 0.12),
      text(id(2, 4), '标题', 3, 'title', { x: 0.09, y: 0.09, width: 0.82, height: 0.1, rotation: 0 }, '周末甜品探店', { size: 104, weight: 800, fill: '#D6455F', align: 'center', description: '超粗圆润标题，玫红色，活泼醒目' }),
      text(id(2, 5), '副标题', 4, 'subtitle', { x: 0.09, y: 0.19, width: 0.82, height: 0.06, rotation: 0 }, '3 家宝藏小店，人均 50 元', { size: 44, weight: 600, fill: '#5A4A4A', align: 'center', description: '深灰色说明文字' }),
      rect(id(2, 6), '角标', 5, 'badge', { x: 0.66, y: 0.3, width: 0.28, height: 0.06, rotation: -6 }, '#FFD25C', 0.4),
      text(id(2, 7), '角标文字', 6, 'tag', { x: 0.66, y: 0.305, width: 0.28, height: 0.05, rotation: -6 }, '亲测好吃', { size: 36, weight: 700, fill: '#5A3A00', align: 'center', description: '黄色贴纸上的深色字' })
    ]
  }
}

function productMain(): Fixture {
  return {
    canvas: { aspectWidth: 1, aspectHeight: 1, outputWidth: 1024, outputHeight: 1024, backgroundColor: '#F2F4F7', transparent: false, globalStyle: '电商商品主图，干净浅灰背景，棚拍柔光，突出产品' },
    elements: [
      rect(id(3, 1), '浅灰背景', 0, 'background', { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, '#F2F4F7'),
      rect(id(3, 2), '展台', 1, 'decoration', { x: 0.2, y: 0.72, width: 0.6, height: 0.1, rotation: 0 }, '#DDE3EA', 0, 'ellipse'),
      subject(id(3, 3), '保温杯', 2, { x: 0.3, y: 0.18, width: 0.4, height: 0.6, rotation: 0 }, '一只磨砂质感的不锈钢保温杯', 'product', '棚拍柔光，产品居中，轮廓清晰，背景透明'),
      text(id(3, 4), '卖点一', 3, 'title', { x: 0.05, y: 0.06, width: 0.5, height: 0.07, rotation: 0 }, '316 不锈钢内胆', { size: 44, weight: 700, fill: '#1F2A37', description: '深色粗体卖点' }),
      text(id(3, 5), '卖点二', 4, 'feature', { x: 0.05, y: 0.13, width: 0.5, height: 0.06, rotation: 0 }, '12 小时保温 · 一键开盖', { size: 34, fill: '#4B5563', description: '灰色说明卖点' }),
      rect(id(3, 6), '价格条', 5, 'badge', { x: 0.62, y: 0.84, width: 0.33, height: 0.11, rotation: 0 }, '#E5484D', 0.3),
      text(id(3, 7), '价格', 6, 'price', { x: 0.62, y: 0.855, width: 0.33, height: 0.08, rotation: 0 }, '到手 ¥69', { size: 52, weight: 800, fill: '#FFFFFF', align: 'center', description: '白色粗体价格' }),
      rect(id(3, 8), '新品角标', 7, 'badge', { x: 0.82, y: 0.05, width: 0.13, height: 0.13, rotation: 0 }, '#111827', 0, 'ellipse'),
      text(id(3, 9), '新品', 8, 'tag', { x: 0.82, y: 0.09, width: 0.13, height: 0.05, rotation: 0 }, '新品', { size: 36, weight: 700, fill: '#FFFFFF', align: 'center', description: '白色小标签字' })
    ]
  }
}

function saleBanner(): Fixture {
  return {
    canvas: { aspectWidth: 16, aspectHeight: 9, outputWidth: 1600, outputHeight: 900, backgroundColor: '#2B1B5A', transparent: false, globalStyle: '店铺促销横幅，深紫到洋红的热闹氛围，节日灯光，醒目' },
    elements: [
      rect(id(4, 1), '深紫背景', 0, 'background', { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, '#2B1B5A'),
      rect(id(4, 2), '光晕', 1, 'decoration', { x: 0.52, y: -0.2, width: 0.6, height: 1.1, rotation: 0 }, '#7A2E8E', 0, 'ellipse'),
      subject(id(4, 3), '礼盒与彩带', 2, { x: 0.58, y: 0.14, width: 0.36, height: 0.74, rotation: 0 }, '堆叠的礼盒，飘着彩带和金色亮片', 'product', '节日灯光，暖色高光，背景透明'),
      text(id(4, 4), '标题', 3, 'title', { x: 0.06, y: 0.2, width: 0.5, height: 0.2, rotation: 0 }, '双十一 全场满减', { size: 120, weight: 800, fill: '#FFFFFF', description: '超粗白色大标题，热闹醒目' }),
      text(id(4, 5), '副标题', 4, 'subtitle', { x: 0.06, y: 0.44, width: 0.5, height: 0.1, rotation: 0 }, '满 199 减 50 · 11 月 1 日起', { size: 52, weight: 600, fill: '#FFD6F1', description: '浅粉色活动说明' }),
      rect(id(4, 6), '按钮', 5, 'button', { x: 0.06, y: 0.64, width: 0.2, height: 0.12, rotation: 0 }, '#FFC83D', 0.5),
      text(id(4, 7), '按钮文字', 6, 'cta', { x: 0.06, y: 0.665, width: 0.2, height: 0.07, rotation: 0 }, '立即抢购', { size: 48, weight: 800, fill: '#3B1D00', align: 'center', description: '深色粗体按钮文字' })
    ]
  }
}

export function createMerchantExampleScene(key: MerchantExampleKey, options: ExampleOptions = {}): Scene {
  const scene = createBlankScene(options)
  const fixture = key === 'coffee-poster' ? coffeePoster()
    : key === 'xiaohongshu-cover' ? xiaohongshuCover()
      : key === 'product-main' ? productMain()
        : saleBanner()
  return sceneSchema.parse({ ...scene, canvas: fixture.canvas, elements: fixture.elements })
}
