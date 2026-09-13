// This generation also changes when reopening the same project.
let generation = 0
let hydrating = false
let writable = true
export function beginProjectHydration(): void { generation += 1; hydrating = true }
export function endProjectHydration(): void { hydrating = false }
export function projectHydrating(): boolean { return hydrating }
export function projectGeneration(): number { return generation }
export function setProjectContextWritable(value: boolean): void { writable = value }
export function projectContextWritable(): boolean { return writable }
