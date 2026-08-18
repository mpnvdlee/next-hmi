/* @jsxRuntime classic */
export const schema = {
  variable: { type: 'float' as const, label: 'Value', group: 'Data' },
  min: { type: 'float' as const, label: 'Min value', group: 'Data', step: 1, defaultValue: 0 },
  max: { type: 'float' as const, label: 'Max value', group: 'Data', step: 1, defaultValue: 100 },
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  unit: { type: 'string' as const, label: 'Unit', group: 'Content' },
};

export const description = 'A round analog gauge with min/max and a value binding.';
export const category = 'Indicators';
export const icon = { type: 'builtin', name: 'gauge' } as const;

// Dial geometry, in the viewBox's own units. The arc is stroked at radius R
// with a stroke width of 18 (see style.css), so it occupies 47…65 from the
// centre. The endpoints sit 20° below the horizontal — the lowest ink on the
// dial, at CY + R·sin(20°) + 9 — so CY is what keeps the stroke inside the
// 140×100 box rather than clipped flat along the bottom edge.
const CX = 70;
const CY = 68;
const R = 56;
const START_ANGLE = 200;
const SWEEP = 220;

function arcPoint(angleDeg: number): string {
  const rad = (angleDeg * Math.PI) / 180;
  return `${(CX + R * Math.cos(rad)).toFixed(2)} ${(CY - R * Math.sin(rad)).toFixed(2)}`;
}

/** Path for the leading `fraction` (0…1) of the dial's 220° arc. */
function arcPath(fraction: number): string {
  const swept = SWEEP * fraction;
  // Angles decrease left-to-right across the dial, which is SVG's positive
  // sweep direction in its y-down coordinate space. A zero-length arc has
  // identical endpoints, which the spec renders as nothing at all.
  return `M ${arcPoint(START_ANGLE)} A ${R} ${R} 0 ${swept > 180 ? 1 : 0} 1 ${arcPoint(
    START_ANGLE - swept,
  )}`;
}

export default function Gauge({ properties, layout }: HmiWidgetProps) {
  const rawValue = usePropVar(properties, 'variable');
  const value = typeof rawValue === 'number' ? rawValue : 0;

  const min = usePropNumber(properties, 'min', 0);
  const max = usePropNumber(properties, 'max', 100);
  const label = usePropString(properties, 'label', '');
  const unit = usePropString(properties, 'unit', '');

  const fraction = Math.min(1, Math.max(0, (value - min) / (max - min || 1)));
  const displayValue = typeof rawValue === 'number' ? rawValue.toFixed(1) : '---';

  return (
    <div className="hmi-component hmi-gauge" style={selfLayoutStyle(layout)}>
      {label && <span className="hmi-gauge__label">{label}</span>}
      <svg className="hmi-gauge__dial" viewBox="0 0 140 100" aria-hidden="true">
        <path className="hmi-gauge__track" d={arcPath(1)} />
        <path className="hmi-gauge__fill" d={arcPath(fraction)} />
      </svg>
      <div className="hmi-gauge__value">
        {displayValue}
        {unit && <span className="hmi-gauge__unit">{unit}</span>}
      </div>
    </div>
  );
}
