import { z } from 'zod'

/** A deferred reference is resolved only against an earlier tool in the same persisted plan. */
export const agentResultReferenceSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^generated:(?:[0-9]|1[01])$/)
]).describe('已有结果使用真实 UUID；同一计划中尚未完成的生图使用 generated:N，N 是 tools 数组中生图工具的零起始索引。')
