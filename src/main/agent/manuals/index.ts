import type { ManualLibrary } from '../tools/types'
import banner from './banner.md?raw'
import chineseTypography from './chinese-typography.md?raw'
import color from './color.md?raw'
import coverArt from './cover-art.md?raw'
import imagePrompting from './image-prompting.md?raw'
import posterLayout from './poster-layout.md?raw'
import productHero from './product-hero.md?raw'
import socialVertical from './social-vertical.md?raw'

/** Bump when a manual changes, so eval reports can tie results to the text the model read. */
export const MANUALS_VERSION = 'manuals-3'

const MANUALS = [
  { id: 'poster-layout', title: '海报版式', purpose: '版式骨架、层级、留白和常见问题的改法', text: posterLayout },
  { id: 'product-hero', title: '商品主图', purpose: '电商主图和产品海报的构图、卖点文字和光影', text: productHero },
  { id: 'cover-art', title: '唱片与书籍封面', purpose: '方形唱片封面和书籍封面的结构与标题', text: coverArt },
  { id: 'social-vertical', title: '社媒竖版', purpose: '小红书、抖音等竖版首图的安全区和大字报版式', text: socialVertical },
  { id: 'banner', title: '横幅', purpose: '16:9 和通栏横幅的横向阅读与左右布局', text: banner },
  { id: 'chinese-typography', title: '中文排版', purpose: '字体、字间距、行高、中英混排和竖排', text: chineseTypography },
  { id: 'color', title: '配色', purpose: '主辅色比例、按情绪选色、光色与对比', text: color },
  { id: 'image-prompting', title: '生图提示词写法', purpose: '按生图模型家族写 brief，以及局部修改的写法', text: imagePrompting }
] as const

export const BUILT_IN_MANUALS: ManualLibrary = {
  version: MANUALS_VERSION,
  list: () => MANUALS.map(({ id, title, purpose }) => ({ id, title, purpose })),
  load: (id) => MANUALS.find((manual) => manual.id === id)?.text.trim() ?? null
}
