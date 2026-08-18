import './style.css';
import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import ResizeHandle from '../ResizeHandle';
import { PropsPanelDrawerSlotContext } from './drawerSlotContext';

interface Props {
  left: ReactNode;
  center: ReactNode;
  right?: ReactNode;
  defaultLeftWidth?: number;
  defaultRightWidth?: number;
  minPanelWidth?: number;
  maxPanelWidth?: number;
  /** Remembers this layout's panel widths across mounts and reloads */
  storageKey?: string;
}

const LEFT_VAR = '--cfg-left-panel-w';
const RIGHT_VAR = '--cfg-right-panel-w';

function storedWidth(key: string | undefined, side: 'left' | 'right', fallback: number) {
  if (!key) return fallback;
  try {
    const raw = window.localStorage.getItem(`cfg-layout:${key}:${side}`);
    const parsed = raw === null ? NaN : Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function storeWidth(key: string | undefined, side: 'left' | 'right', width: number) {
  if (!key) return;
  try {
    window.localStorage.setItem(`cfg-layout:${key}:${side}`, String(width));
  } catch {
    /* private mode / quota — the width just won't be remembered */
  }
}

export default function ConfigLayout({
  left,
  center,
  right,
  defaultLeftWidth = 260,
  defaultRightWidth = 340,
  minPanelWidth = 200,
  maxPanelWidth = 600,
  storageKey,
}: Props) {
  const layout = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState(() =>
    storedWidth(storageKey, 'left', defaultLeftWidth),
  );
  const [rightWidth, setRightWidth] = useState(() =>
    storedWidth(storageKey, 'right', defaultRightWidth),
  );
  const [drawerSlot, setDrawerSlot] = useState<HTMLDivElement | null>(null);

  // Dragging writes the column width straight to the grid so the panels track
  // the pointer without re-rendering the tree and the properties panel; React
  // state only catches up when the drag ends.
  const dragLeft = useCallback((w: number) => {
    layout.current?.style.setProperty(LEFT_VAR, `${w}px`);
  }, []);
  const dragRight = useCallback((w: number) => {
    layout.current?.style.setProperty(RIGHT_VAR, `${w}px`);
  }, []);

  const commitLeft = useCallback(
    (w: number) => {
      setLeftWidth(w);
      storeWidth(storageKey, 'left', w);
    },
    [storageKey],
  );
  const commitRight = useCallback(
    (w: number) => {
      setRightWidth(w);
      storeWidth(storageKey, 'right', w);
    },
    [storageKey],
  );

  const widths = {
    [LEFT_VAR]: `${leftWidth}px`,
    [RIGHT_VAR]: `${rightWidth}px`,
  } as CSSProperties;

  return (
    <div
      ref={layout}
      className={`cfg-layout${right ? ' cfg-layout--with-right' : ''}`}
      style={widths}
    >
      <aside className="cfg-sidebar cfg-flex-col">{left}</aside>
      <ResizeHandle
        width={leftWidth}
        onResize={dragLeft}
        onResizeEnd={commitLeft}
        side="left"
        min={minPanelWidth}
        max={maxPanelWidth}
        defaultWidth={defaultLeftWidth}
        label="Resize left panel"
      />
      <div className="cfg-center cfg-flex-col">{center}</div>
      {right && (
        <>
          <ResizeHandle
            width={rightWidth}
            onResize={dragRight}
            onResizeEnd={commitRight}
            side="right"
            min={minPanelWidth}
            max={maxPanelWidth}
            defaultWidth={defaultRightWidth}
            label="Resize right panel"
          />
          <aside className="cfg-props-panel cfg-flex-col">
            <div className="cfg-props-panel__scroll">
              <PropsPanelDrawerSlotContext.Provider value={drawerSlot}>
                {right}
              </PropsPanelDrawerSlotContext.Provider>
            </div>
            <div ref={setDrawerSlot} />
          </aside>
        </>
      )}
    </div>
  );
}
