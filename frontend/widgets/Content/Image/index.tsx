/* @jsxRuntime classic */
export const schema = {
  src: { type: 'image' as const, label: 'Image' },
  alt: { type: 'string' as const, label: 'Alt text' },
  fit: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Fit',
    defaultValue: 'contain',
    options: [
      { label: 'Contain', value: 'contain' },
      { label: 'Cover', value: 'cover' },
      { label: 'Fill', value: 'fill' },
      { label: 'None', value: 'none' },
      { label: 'Scale down', value: 'scale-down' },
    ],
  },
  rotation: {
    type: 'integer' as const,
    label: 'Rotation (°)',
    defaultValue: 0,
    step: 90,
    description: 'Turns the picture clockwise. Bind it to show one asset in any orientation.',
  },
  indicators: { type: 'image-indicators' as const, label: 'Indicators' },
};

export const description = 'Shows an asset with a fit mode and optional data-driven indicators.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'image-square' } as const;

type ObjectFit = 'contain' | 'cover' | 'fill' | 'none' | 'scale-down';

interface ImageIndicator {
  id: string;
  label: string;
  /** Black pill position (0–1 normalized) */
  x: number;
  y: number;
  /** Red circle position, defaults to x/y when absent */
  rx?: number;
  ry?: number;
  /** Red circle diameter as % of image container width (default 10) */
  rSize?: number;
}

export default function Image({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  // A browser fetches the source, so its numbers keep their point.
  const src = assetSrc(getPropString(properties, 'src', '', { ...evalCtx, machineText: true }));
  const alt = getPropString(properties, 'alt', '', evalCtx);
  const fit = getPropString(properties, 'fit', 'contain', evalCtx) as ObjectFit;
  const rotation = getPropNumber(properties, 'rotation', 0, evalCtx);
  const indicators = (
    Array.isArray(properties?.indicators) ? properties.indicators : []
  ) as ImageIndicator[];

  if (!src) {
    return (
      <div className="hmi-component hmi-image hmi-image--empty" style={selfLayoutStyle(layout)}>
        <span className="hmi-image__placeholder">No image</span>
      </div>
    );
  }

  return (
    <div
      className="hmi-component hmi-image"
      style={{ ...selfLayoutStyle(layout), '--hmi-image-rotation': `${rotation}deg` }}
    >
      <img
        className="hmi-image__img"
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        style={{ objectFit: fit }}
      />
      {indicators.map((ind) => {
        const pillX = ind.rx ?? ind.x;
        const pillY = ind.ry ?? ind.y;
        const size = ind.rSize ?? 10;
        return (
          <div key={ind.id}>
            <div
              className="hmi-image__indicator"
              style={{ left: `${ind.x * 100}%`, top: `${ind.y * 100}%` }}
            >
              {ind.label}
            </div>
            <div
              className="hmi-image__indicator-pill"
              style={{
                left: `${pillX * 100}%`,
                top: `${pillY * 100}%`,
                width: `${size}%`,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
