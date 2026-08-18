import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ChildPosition, HmiWidgetProps } from '@shared/types/config';
import WidgetRenderer from '../WidgetRenderer';
import { useEvalContext } from '@hmi/hooks/useEvalContext';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useHmiScope } from '@hmi/context/HmiScopeContext';
import { getPropBoolean, getPropNumber, getPropString, selfLayoutStyle } from '../layoutUtils';
import { clamp01, indexPositions, pruneOrphanPositions, resolveMarkerLabel } from './positions';
import styles from './index.module.css';

const VALID_FITS = new Set(['contain', 'cover', 'fill', 'none', 'scale-down']);

export default function ImageContainer({ properties, layout, childConfigs }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const scope = useHmiScope();
  const currentUser = useHmiStore((s) => s.currentUsersByScope[scope]);
  const userGroups: string[] = currentUser?.groups ?? ['guest'];

  const src = getPropString(properties, 'src', '', evalCtx);
  const alt = getPropString(properties, 'alt', '', evalCtx);
  const fitRaw = getPropString(properties, 'fit', 'contain', evalCtx);
  const fit = VALID_FITS.has(fitRaw) ? fitRaw : 'contain';
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
      setIsCollapsed((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapseBelow]);

  const rawPositions = properties?.childPositions as ChildPosition[] | undefined;
  const allChildren = childConfigs ?? [];
  const userGroupsKey = userGroups.join('|');

  const placedChildren = useMemo(() => {
    const positions = pruneOrphanPositions(rawPositions, allChildren);
    const positionsById = indexPositions(positions);
    return allChildren
      .map((child, treeIndex) => {
        if (!getPropBoolean(child.properties, 'visible', true, evalCtx)) return null;
        const pos = positionsById.get(child.id);
        return {
          child,
          x: clamp01(pos?.x ?? 0.5),
          y: clamp01(pos?.y ?? 0.5),
          label: resolveMarkerLabel(pos, treeIndex),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    // userGroupsKey is the stable signature for userGroups; eslint can't see it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawPositions, allChildren, userGroupsKey]);

  const aspectStyle: CSSProperties = imgAspect
    ? { aspectRatio: `${imgAspect.w} / ${imgAspect.h}` }
    : {};
  const hostStyle: CSSProperties = {
    ...selfLayoutStyle(layout),
  };

  const hostClass =
    `hmi-component ${styles.host}` + (isCollapsed ? ` ${styles.hostCollapsed}` : '');

  return (
    <div ref={hostRef} className={hostClass} style={hostStyle} data-collapsed={isCollapsed}>
      <div className={styles.canvas}>
        <div className={styles.imageStage} style={aspectStyle}>
          {src ? (
            <img
              className={styles.img}
              src={src}
              alt={alt}
              draggable={false}
              data-fit={fit}
              loading="lazy"
              decoding="async"
              onLoad={(e) => {
                const img = e.currentTarget;
                const w = img.naturalWidth;
                const h = img.naturalHeight;
                if (w > 0 && h > 0) {
                  setImgAspect((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
                }
              }}
            />
          ) : null}
          <div className={styles.markerLayer} aria-hidden="true">
            {placedChildren.map(({ child, x, y, label }) => (
              <span
                key={`m-${child.id}`}
                className={styles.imgMarker}
                style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
              >
                {label}
              </span>
            ))}
          </div>
        </div>
        <div className={styles.slots}>
          {placedChildren.map(({ child, x, y, label }) => {
            const slotStyle: CSSProperties = {
              ['--hmi-imgctn-x' as string]: `${x * 100}%`,
              ['--hmi-imgctn-y' as string]: `${y * 100}%`,
            } as CSSProperties;
            return (
              <div
                key={`s-${child.id}`}
                className={styles.slot}
                style={slotStyle}
                data-child-id={child.id}
              >
                <span className={styles.markerInline}>{label}</span>
                <div className={styles.childBody}>
                  <WidgetRenderer node={child} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
