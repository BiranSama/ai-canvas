import { describe, expect, it } from 'vitest'
import { simplePropertySchema } from '../../src/renderer/src/inspector/property-schema'

describe('SimplePropertySchema', () => {
  it('provides five to seven intentional fields for every element type', () => {
    for (const [type, fields] of Object.entries(simplePropertySchema)) {
      expect(fields.length, type).toBeGreaterThanOrEqual(5)
      expect(fields.length, type).toBeLessThanOrEqual(7)
      expect(new Set(fields.map((field) => field.id)).size, type).toBe(fields.length)
      expect(fields.every((field) => field.label.trim().length > 0), type).toBe(true)
    }
  })
})
