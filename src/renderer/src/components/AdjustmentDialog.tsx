import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdjustmentSettings } from '../../../domain'
import { ADJUSTMENT_LABELS } from '../../../shared/adjustments'
import { commitLayerAdjustment, layerHistogram, useAdjustmentDialog, type AdjustmentDialogState } from '../adjustments/adjustment-actions'
import { useAdjustmentPreview } from '../canvas/adjustment-preview'
import { useModalScope } from '../interaction/use-modal-scope'
import { useWorkspaceStore } from '../store/workspace-store'
import { AdjustmentControls } from './AdjustmentControls'

/*
 * Photoshop's adjustment dialog for an image layer (Ctrl+L, Ctrl+M, …): the
 * canvas shows the result as the controls move, 预览 compares with how the
 * layer was, 确定 records one step and 取消 leaves the layer as it was. The
 * dialog sits beside the canvas so the picture stays in view.
 */

function DialogBody({ open }: { readonly open: AdjustmentDialogState }): React.JSX.Element {
  const close = useAdjustmentDialog((state) => state.close)
  const element = useWorkspaceStore((state) => state.scene.elements.find((candidate) => candidate.id === open.elementId))
  const [settings, setSettings] = useState<AdjustmentSettings>(open.adjustment.settings)
  const [preview, setPreview] = useState(true)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLFormElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  // What the adjustment works on, measured once as the dialog opens.
  const histogram = useMemo(() => element?.type === 'image' ? layerHistogram(element, open.adjustment.id) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measured on opening; the layer does not change while the dialog is open
    [])

  useEffect(() => {
    const store = useAdjustmentPreview.getState()
    if (!preview) { store.clear(open.elementId); return }
    store.show({
      kind: 'layer',
      elementId: open.elementId,
      adjustment: { ...open.adjustment, settings, ...(open.clip === null ? {} : { clip: open.clip.id }) },
      shown: true,
      clip: open.clip === null ? null : { id: open.clip.id, pixels: open.clip.pixels }
    })
  }, [open, settings, preview])
  useEffect(() => () => useAdjustmentPreview.getState().clear(open.elementId), [open.elementId])

  const cancel = (): void => {
    useAdjustmentPreview.getState().clear(open.elementId)
    close()
  }
  useModalScope(ref, cancel, { initialFocus: confirm })

  return (
    <div className="adjustment-dialog-layer" role="presentation">
      <form
        ref={ref}
        className="edit-dialog adjustment-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={ADJUSTMENT_LABELS[settings.kind]}
        onSubmit={(event) => {
          event.preventDefault()
          if (busy) return
          setBusy(true)
          void commitLayerAdjustment(open, settings).finally(() => {
            useAdjustmentPreview.getState().clear(open.elementId)
            close()
          })
        }}
      >
        <h2>{ADJUSTMENT_LABELS[settings.kind]}</h2>
        {element !== undefined && <p className="field-note">{open.clip === null ? `调整「${element.name}」` : `调整「${element.name}」的选区部分`}</p>}
        <AdjustmentControls settings={settings} histogram={histogram} onChange={(next) => setSettings(next)} />
        <footer>
          <label className="checkbox-field adjustment-preview-toggle"><input type="checkbox" checked={preview} onChange={(event) => setPreview(event.currentTarget.checked)} /><span>预览</span></label>
          <button type="button" onClick={cancel}>取消</button>
          <button ref={confirm} type="submit" className="is-primary" disabled={busy}>确定</button>
        </footer>
      </form>
    </div>
  )
}

export function AdjustmentDialog(): React.JSX.Element | null {
  const open = useAdjustmentDialog((state) => state.open)
  return open === null ? null : <DialogBody key={open.adjustment.id} open={open} />
}
