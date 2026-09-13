import { z } from 'zod'

export const diagnosticExportInputSchema = z.object({}).strict()

export const diagnosticExportResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('saved'),
    fileName: z.string().trim().min(1).max(255),
    correlationId: z.null(),
    message: z.string().trim().min(1).max(500)
  }),
  z.object({
    status: z.literal('cancelled'),
    fileName: z.null(),
    correlationId: z.null(),
    message: z.string().trim().min(1).max(500)
  }),
  z.object({
    status: z.literal('failed'),
    fileName: z.null(),
    correlationId: z.string().uuid(),
    message: z.string().trim().min(1).max(500)
  })
])

export type DiagnosticExportInput = z.infer<typeof diagnosticExportInputSchema>
export type DiagnosticExportResult = z.infer<typeof diagnosticExportResultSchema>
