import { BRAND_COLOR_LIST_ID, useBrandStore } from '../store/brand-store'

/** The brand's colours, offered first by every colour picker in the editor. */
export function BrandColorList(): React.JSX.Element {
  const colors = useBrandStore((state) => state.colors)
  return (
    <datalist id={BRAND_COLOR_LIST_ID} data-testid="brand-color-list">
      {colors.map((color) => <option key={color} value={color.toLowerCase()} />)}
    </datalist>
  )
}
