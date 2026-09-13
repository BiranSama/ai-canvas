export function LiquidGlassDefs(): React.JSX.Element {
  return (
    <svg className="liquid-glass-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter id="ai-liquid-glass-fine" x="-12%" y="-12%" width="124%" height="124%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.008 0.024" numOctaves="2" seed="17" result="glassNoise" />
          <feGaussianBlur in="glassNoise" stdDeviation="0.42" result="softNoise" />
          <feDisplacementMap in="SourceGraphic" in2="softNoise" scale="10" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="ai-liquid-glass-satin" x="-8%" y="-8%" width="116%" height="116%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.035" numOctaves="1" seed="29" result="satinNoise" />
          <feGaussianBlur in="satinNoise" stdDeviation="0.65" result="softSatinNoise" />
          <feDisplacementMap in="SourceGraphic" in2="softSatinNoise" scale="4" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  )
}

