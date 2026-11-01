import { useEffect, useState } from 'react'

type Snapshots = { readonly before: string | null; readonly after: string }

function useAssetUrl(assetId: string | null, projectId: string): string | null {
  const [loaded, setLoaded] = useState<{ readonly assetId: string; readonly url: string } | null>(null)
  useEffect(() => {
    if (assetId === null) return
    let current = true
    window.desktop.readGenerationAsset(assetId, false, projectId)
      .then((url) => { if (current) setLoaded({ assetId, url }) })
      .catch(() => undefined)
    return () => { current = false }
  }, [assetId, projectId])
  return loaded !== null && loaded.assetId === assetId ? loaded.url : null
}

/** The canvas at the end of a turn, small, and the canvas before and after side by side when opened. */
export function TurnSnapshotThumbnail({ snapshots, projectId, open, onToggle }: {
  readonly snapshots: Snapshots
  readonly projectId: string
  readonly open: boolean
  readonly onToggle: () => void
}): React.JSX.Element {
  const after = useAssetUrl(snapshots.after, projectId)
  return (
    <button type="button" className="turn-snapshot-thumb" aria-expanded={open} aria-label={open ? '收起前后对比' : '对比这一轮前后'} onClick={onToggle}>
      {after === null ? <span aria-hidden="true" /> : <img src={after} alt="" />}
    </button>
  )
}

export function TurnSnapshotCompare({ snapshots, projectId }: {
  readonly snapshots: Snapshots
  readonly projectId: string
}): React.JSX.Element {
  const before = useAssetUrl(snapshots.before, projectId)
  const after = useAssetUrl(snapshots.after, projectId)
  return (
    <div className="turn-snapshot-compare" data-testid="turn-snapshot-compare">
      <figure>
        {snapshots.before === null ? <p>没有拍到这一轮开始时的画面。</p> : before === null ? <span aria-hidden="true" /> : <img src={before} alt="这一轮之前的画面" />}
        <figcaption>之前</figcaption>
      </figure>
      <figure>
        {after === null ? <span aria-hidden="true" /> : <img src={after} alt="这一轮之后的画面" />}
        <figcaption>之后</figcaption>
      </figure>
    </div>
  )
}
