import { useCallback, useEffect, useRef, useState } from 'react'

interface ImeSafeSharedProps {
  readonly value: string
  readonly onCommit: (value: string) => void
  readonly commitDelayMs?: number | null | undefined
  readonly onEscape?: (() => void) | undefined
  readonly onDraftChange?: ((value: string) => void) | undefined
  readonly onBlurComplete?: (() => void) | undefined
}

type ImeSafeInputProps = ImeSafeSharedProps & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onCompositionStart' | 'onCompositionEnd'> & {
  readonly commitOnEnter?: boolean
}

type ImeSafeTextareaProps = ImeSafeSharedProps & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onCompositionStart' | 'onCompositionEnd'>

interface DraftBinding {
  readonly draft: string
  readonly setFromInput: (value: string) => void
  readonly beginComposition: () => void
  readonly endComposition: (value: string) => void
  readonly focus: () => void
  readonly blur: () => void
  readonly commit: () => void
  readonly revert: () => void
  readonly composing: () => boolean
}

function useImeSafeDraft({ value, onCommit, commitDelayMs = 320, onEscape, onDraftChange }: ImeSafeSharedProps): DraftBinding {
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(value)
  const externalValueRef = useRef(value)
  const onCommitRef = useRef(onCommit)
  const onEscapeRef = useRef(onEscape)
  const onDraftChangeRef = useRef(onDraftChange)
  const composingRef = useRef(false)
  const focusedRef = useRef(false)
  const dirtyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { onCommitRef.current = onCommit }, [onCommit])
  useEffect(() => { onEscapeRef.current = onEscape }, [onEscape])
  useEffect(() => { onDraftChangeRef.current = onDraftChange }, [onDraftChange])

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const commit = useCallback((): void => {
    clearTimer()
    if (!dirtyRef.current || composingRef.current) return
    const next = draftRef.current
    dirtyRef.current = false
    if (next === externalValueRef.current) return
    externalValueRef.current = next
    onCommitRef.current(next)
  }, [clearTimer])

  const scheduleCommit = useCallback((): void => {
    clearTimer()
    if (commitDelayMs === null) return
    timerRef.current = setTimeout(commit, commitDelayMs)
  }, [clearTimer, commit, commitDelayMs])

  useEffect(() => {
    externalValueRef.current = value
    if (!composingRef.current && (!focusedRef.current || !dirtyRef.current)) {
      draftRef.current = value
      setDraft(value)
    }
  }, [value])

  useEffect(() => () => clearTimer(), [clearTimer])

  const updateDraft = useCallback((next: string): void => {
    draftRef.current = next
    dirtyRef.current = true
    setDraft(next)
    onDraftChangeRef.current?.(next)
  }, [])

  return {
    draft,
    setFromInput(next) {
      updateDraft(next)
      if (!composingRef.current) scheduleCommit()
    },
    beginComposition() {
      composingRef.current = true
      clearTimer()
    },
    endComposition(next) {
      composingRef.current = false
      updateDraft(next)
      scheduleCommit()
    },
    focus() {
      focusedRef.current = true
    },
    blur() {
      focusedRef.current = false
      composingRef.current = false
      commit()
    },
    commit,
    revert() {
      clearTimer()
      composingRef.current = false
      dirtyRef.current = false
      draftRef.current = externalValueRef.current
      setDraft(externalValueRef.current)
      onDraftChangeRef.current?.(externalValueRef.current)
      onEscapeRef.current?.()
    },
    composing: () => composingRef.current
  }
}

export function ImeSafeInput({
  value,
  onCommit,
  commitDelayMs,
  commitOnEnter = false,
  onEscape,
  onDraftChange,
  onBlurComplete,
  onFocus,
  onKeyDown,
  ...props
}: ImeSafeInputProps): React.JSX.Element {
  const binding = useImeSafeDraft({ value, onCommit, commitDelayMs, onEscape, onDraftChange })
  return (
    <input
      {...props}
      value={binding.draft}
      onFocus={(event) => { binding.focus(); onFocus?.(event) }}
      onChange={(event) => binding.setFromInput(event.currentTarget.value)}
      onCompositionStart={binding.beginComposition}
      onCompositionEnd={(event) => binding.endComposition(event.currentTarget.value)}
      onBlur={() => { binding.blur(); onBlurComplete?.() }}
      onKeyDown={(event) => {
        if (binding.composing() || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Escape') {
          event.preventDefault()
          binding.revert()
          return
        }
        if (commitOnEnter && event.key === 'Enter' && !binding.composing() && !event.nativeEvent.isComposing) {
          event.preventDefault()
          binding.commit()
        }
        onKeyDown?.(event)
      }}
    />
  )
}

export function ImeSafeTextarea({
  value,
  onCommit,
  commitDelayMs,
  onEscape,
  onDraftChange,
  onBlurComplete,
  onFocus,
  onKeyDown,
  ...props
}: ImeSafeTextareaProps): React.JSX.Element {
  const binding = useImeSafeDraft({ value, onCommit, commitDelayMs, onEscape, onDraftChange })
  return (
    <textarea
      {...props}
      value={binding.draft}
      onFocus={(event) => { binding.focus(); onFocus?.(event) }}
      onChange={(event) => binding.setFromInput(event.currentTarget.value)}
      onCompositionStart={binding.beginComposition}
      onCompositionEnd={(event) => binding.endComposition(event.currentTarget.value)}
      onBlur={() => { binding.blur(); onBlurComplete?.() }}
      onKeyDown={(event) => {
        if (binding.composing() || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Escape') {
          event.preventDefault()
          binding.revert()
          return
        }
        onKeyDown?.(event)
      }}
    />
  )
}
