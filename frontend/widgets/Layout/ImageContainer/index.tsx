/* @jsxRuntime classic */
export const schema = {
  src: { type: 'image' as const, label: 'Image', group: 'Image' },
  alt: { type: 'String' as const, label: 'Alt text', group: 'Image' },
  fit: {
    type: 'String' as const,
    format: 'select' as const,
    label: 'Fit',
    group: 'Image',
    defaultValue: 'contain',
    options: [
      { label: 'Contain', value: 'contain' },
      { label: 'Cover', value: 'cover' },
      { label: 'Fill', value: 'fill' },
      { label: 'None', value: 'none' },
      { label: 'Scale down', value: 'scale-down' },
    ],
  },
  collapseBelow: {
    type: 'Integer' as const,
    label: 'Collapse below (px)',
    group: 'Responsive',
    description:
      'Below this width the image drops out and children stack in normal flow. 0 never collapses.',
    defaultValue: 0,
    min: 0,
    max: 4096,
    step: 1,
  },
  childPositions: {
    type: 'child-positions' as const,
    label: 'Child placement',
    group: 'Children',
  },
};

export const displayName = 'Image Container';
export const category = 'Layout & structure';
export const description =
  'Places children at absolute spots over a background image. Collapses below a set width.';
export const icon = { type: 'builtin', name: 'frame-corners' } as const;
/** Nodes of this type carry a `children` array. Unlike a plain container it
 *  places each one itself, from `childConfigs` — every child needs the position
 *  entry that its id, not its order, is keyed by. */
export const hostsChildren = true;

/** A child-placement entry, keyed by child id. Mirrors ChildPosition in
 *  @shared/types/config. */
interface Placement {
  id: string;
  x: number;
  y: number;
  label?: string;
  width?: number;
}

const VALID_FITS = ['contain', 'cover', 'fill', 'none', 'scale-down'];

// Render-time half of @shared/utils/childPositions, which the editor's
// placement panel owns. Duplicated rather than imported: a widget module carries
// no app imports. `index.test.tsx` asserts both halves agree.

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** A–Z, then AA, AB, … Excel-style, from a zero-based tree index. */
function autoMarkerLabel(index: number): string {
  if (index < 0) return '';
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Row-major spot in an 8 × 8 grid inset to 0.1–0.8; repeats after 64. */
function defaultPositionForIndex(index: number): { x: number; y: number } {
  const cell = index % 64;
  return { x: 0.1 + (cell % 8) * 0.1, y: 0.1 + Math.floor(cell / 8) * 0.1 };
}

function markerLabel(entry: Placement | undefined, treeIndex: number): string {
  const manual = entry?.label?.trim();
  return manual ? manual : autoMarkerLabel(treeIndex);
}

export default function ImageContainer({ properties, layout, childConfigs }: HmiWidgetProps) {
  const evalCtx = useEvalContext();

  const src = assetSrc(getPropString(properties, 'src', '', evalCtx));
  const alt = getPropString(properties, 'alt', '', evalCtx);
  const fitRaw = getPropString(properties, 'fit', 'contain', evalCtx);
  const fit = VALID_FITS.includes(fitRaw) ? fitRaw : 'contain';
  const collapseBelowRaw = getPropNumber(properties, 'collapseBelow', 0, evalCtx);
  const collapseBelow = collapseBelowRaw > 0 ? collapseBelowRaw : 0;

  const [imgAspect, setImgAspect] = useState<{ w: number; h: number } | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || collapseBelow <= 0) {
      setIsCollapsed(false);
      return undefined;
    }
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      const next = w > 0 && w < collapseBelow;
      setIsCollapsed((prev: boolean) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapseBelow]);

  const rawPositions = properties?.childPositions as Placement[] | undefined;
  const allChildren = childConfigs ?? [];

  // A child hidden by its own `visible` property keeps its marker letter: the
  // letters are tree-order labels the placement panel shows, so they must not
  // shuffle when a binding flips.
  const positionById = new Map(
    Array.isArray(rawPositions) ? rawPositions.map((p) => [p.id, p]) : [],
  );
  // An unplaced child sits where the placement panel will first offer it, so
  // children added without opening the panel do not all stack in the middle.
  let placeableIndex = 0;
  const placedChildren = allChildren
    .map((child, treeIndex) => {
      const entry = positionById.get(child.id);
      // A Repeater placing its copies at item x / y covers the whole image
      // and has no point, no marker, of its own.
      const fills =
        child.type === 'Repeater' &&
        getPropString(child.properties, 'placement', 'flow', evalCtx) === 'items';
      const fallback = fills ? { x: 0.5, y: 0.5 } : defaultPositionForIndex(placeableIndex++);
      return {
        child,
        x: clamp01(entry?.x ?? fallback.x),
        y: clamp01(entry?.y ?? fallback.y),
        label: markerLabel(entry, treeIndex),
        visible: getPropBoolean(child.properties, 'visible', true, evalCtx),
        fills,
      };
    })
    .filter((entry) => entry.visible);

  const stageStyle: Record<string, string> = imgAspect
    ? { aspectRatio: `${imgAspect.w} / ${imgAspect.h}` }
    : {};

  return (
    <div
      ref={hostRef}
      className={'hmi-component hmi-imgctn' + (isCollapsed ? ' hmi-imgctn--collapsed' : '')}
      style={selfLayoutStyle(layout)}
      data-collapsed={isCollapsed}
    >
      <div className="hmi-imgctn__canvas">
        <div className="hmi-imgctn__stage" style={stageStyle}>
          {src ? (
            <img
              className="hmi-imgctn__img"
              src={src}
              alt={alt}
              draggable={false}
              data-fit={fit}
              loading="lazy"
              decoding="async"
              onLoad={(e: { currentTarget: HTMLImageElement }) => {
                const img = e.currentTarget;
                const w = img.naturalWidth;
                const h = img.naturalHeight;
                if (w > 0 && h > 0) {
                  setImgAspect((prev: { w: number; h: number } | null) =>
                    prev && prev.w === w && prev.h === h ? prev : { w, h },
                  );
                }
              }}
            />
          ) : null}
          <div className="hmi-imgctn__markers" aria-hidden="true">
            {placedChildren.map(({ child, x, y, label, fills }) =>
              fills ? null : (
                <span
                  key={`m-${child.id}`}
                  className="hmi-imgctn__marker"
                  style={{ '--hmi-imgctn-x': `${x * 100}%`, '--hmi-imgctn-y': `${y * 100}%` }}
                >
                  {label}
                </span>
              ),
            )}
          </div>
        </div>
        <div className="hmi-imgctn__slots">
          {placedChildren.map(({ child, x, y, label, fills }) =>
            fills ? (
              <div
                key={`s-${child.id}`}
                className="hmi-imgctn__slot hmi-imgctn__slot--fill"
                data-child-id={child.id}
              >
                {renderWidget(child)}
              </div>
            ) : (
              <div
                key={`s-${child.id}`}
                className="hmi-imgctn__slot"
                style={{ '--hmi-imgctn-x': `${x * 100}%`, '--hmi-imgctn-y': `${y * 100}%` }}
                data-child-id={child.id}
              >
                <span className="hmi-imgctn__marker-inline">{label}</span>
                <div className="hmi-imgctn__child">{renderWidget(child)}</div>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
