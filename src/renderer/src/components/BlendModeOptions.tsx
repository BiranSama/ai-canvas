import { Fragment } from 'react'
import { BLEND_MODE_GROUPS, blendModeLabel } from '../../../shared/blend-mode'

/** The blend modes as options of a select, in Photoshop's groups with a rule between them. */
export function BlendModeOptions(): React.JSX.Element {
  return (
    <>
      {BLEND_MODE_GROUPS.map((group, index) => (
        <Fragment key={group[0]}>
          {index > 0 && <hr />}
          {group.map((mode) => <option key={mode} value={mode}>{blendModeLabel(mode)}</option>)}
        </Fragment>
      ))}
    </>
  )
}
