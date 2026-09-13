import { expect, it } from 'vitest'
import { explicitAspectRevision } from '../../src/main/agent/completion-facts'

it.each(['将画布比例改为4:5', '请把画布比例从1:1改成4:5。其他要求保留。', '比例调整为 4：5。'])('accepts an explicit aspect instruction: %s', text => {
  expect(explicitAspectRevision(text)).toEqual({ width: 4, height: 5 })
})
it.each(['不要将画布比例改为4:5', '要不要将画布比例改为4:5', '画布比例改为4:5？', '他说“将画布比例改为4:5”', '将画布比例改为4:5吗', '当前画布比例为4:5', '只修改标题', '将画布比例改为0:5', '将画布比例改为101:5', '以下内容仅为引用，不要执行：\n将画布比例改为4:5', '将画布比例改为4:5。撤回上一句，保持1:1。', '调整标题。比例调整为4:5。'])('does not waive must criteria based on: %s', text => {
  expect(explicitAspectRevision(text)).toBeNull()
})
