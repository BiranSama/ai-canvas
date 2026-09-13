export type CommandErrorCode =
  | 'INVALID_BATCH'
  | 'INVALID_COMMAND'
  | 'INVALID_SCENE'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_EXISTS'
  | 'ELEMENT_LOCKED'
  | 'RELATION_NOT_FOUND'
  | 'RELATION_EXISTS'
  | 'GROUP_INVALID'

export interface CommandErrorDetail {
  readonly code: CommandErrorCode
  readonly message: string
  readonly issues?: readonly string[]
}

export class CommandDomainError extends Error {
  readonly code: CommandErrorCode
  readonly issues: readonly string[] | undefined

  constructor(code: CommandErrorCode, message: string, issues?: readonly string[]) {
    super(message)
    this.name = 'CommandDomainError'
    this.code = code
    this.issues = issues
  }
}

