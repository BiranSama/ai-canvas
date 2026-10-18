import { describe, expect, it } from 'vitest'
import { describeImageModel } from '../../src/shared/image-model-profiles'

describe('image model hints', () => {
  it('states sizes, image count and support from the rules requests follow', () => {
    const seedream45 = describeImageModel('ark-seedream', 'doubao-seedream-4-5-251128')
    expect(seedream45).toContain('预设 2K、4K；或自定义 369 万–1678 万像素，边长取 16 的倍数，长宽比不超过 16:1')
    expect(seedream45).toContain('每次最多 4 张，可出关联组图')
    expect(seedream45).toContain('支持参考图、局部修改（局部修改用标注图引导）')
    expect(describeImageModel('ark-seedream', 'doubao-seedream-5-0-pro-260628')).toContain('每次最多 1 张。')
    expect(describeImageModel('ark-seedream', 'ep-20261018-abcde')).toMatch(/^没认出这个型号/)

    expect(describeImageModel('openai-images', 'gpt-image-1')).toContain('只有 1024×1024、1536×1024、1024×1536')
    expect(describeImageModel('openai-images', 'gpt-image-2')).toBe(
      '尺寸：66 万–829 万像素，边长取 16 的倍数，长边不超过 3840，长宽比不超过 3:1。每次最多 4 张。支持参考图、局部修改、透明背景。'
    )
    expect(describeImageModel('openai-images', 'grok-imagine-image')).toBe(
      '尺寸：按画幅取最接近的比例（1:1、3:4、4:3、2:3、3:2、9:16、16:9），长边超过 1536 用 2k，否则 1k。每次最多 4 张。只按文字生成。'
    )
    expect(describeImageModel('openai-images', 'flux-dev')).toMatch(/^尺寸：按画布尺寸原样发送/)
    expect(describeImageModel('task-images', 'any-model')).toBe('每次 1 张。只按文字生成。')
  })

  it('says nothing before a protocol and model are chosen', () => {
    expect(describeImageModel('unconfigured', 'gpt-image-2')).toBeNull()
    expect(describeImageModel('openai-images', '  ')).toBeNull()
  })
})
