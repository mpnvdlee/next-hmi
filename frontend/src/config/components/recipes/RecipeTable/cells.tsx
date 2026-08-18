import type { RecipeDataType, RecipeParameter } from '@shared/types/recipe';
import { isArrayDataType, elementDataType } from '@shared/types/recipe';
import { ClearIcon } from '@config/components/ui/actionIcons';
import { useVariableStore } from '@hmi/store/variableStore';
import AddButton from '../../ui/AddButton';
import BoolButtonGroup from '../../ui/BoolButtonGroup';
import LiveValue from '../../ui/LiveValue';
import TextField from '../../ui/TextField';

/** One bound parameter's live value. A `$var` binding path is already the
 *  store's `datasource:path` key, so no key building is needed here. */
export function RecipeLiveCell({ path }: { path: string }) {
  // Selecting the single value (not the map) keeps an unrelated variable's tick
  // from re-rendering every row of the table.
  const value = useVariableStore((s) => (path ? s.values[path] : undefined));

  if (!path) return <LiveValue value={undefined} />;

  const text =
    value === undefined
      ? undefined
      : Array.isArray(value)
        ? `[${value.map(String).join(', ')}]`
        : String(value);

  return <LiveValue value={text} />;
}

function defaultScalar(elemType: RecipeDataType): unknown {
  switch (elemType) {
    case 'boolean':
      return false;
    case 'integer':
    case 'float':
      return 0;
    default:
      return '';
  }
}

function ScalarInput({
  elemType,
  value,
  onChange,
}: {
  elemType: RecipeDataType;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (elemType === 'boolean') {
    return (
      <BoolButtonGroup value={value === true} onChange={onChange} labels={['True', 'False']} />
    );
  }

  const text = value === undefined || value === null ? '' : String(value);

  if (elemType === 'integer' || elemType === 'float') {
    return (
      <TextField
        type="number"
        step="any"
        className="cfg-prop-input--compact"
        value={text}
        onCommit={(next) => {
          if (next === '') {
            onChange(null);
            return;
          }
          const num = Number(next);
          if (Number.isFinite(num)) onChange(num);
        }}
      />
    );
  }

  // string / datetime
  return <TextField className="cfg-prop-input--compact" value={text} onCommit={onChange} />;
}

/** One dataset value, typed by its parameter — a scalar control, or an element
 *  list for an array parameter. */
export default function ValueCell({
  param,
  value,
  onChange,
}: {
  param: RecipeParameter;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const elemType = elementDataType(param.dataType);

  if (!isArrayDataType(param.dataType)) {
    return <ScalarInput elemType={elemType} value={value} onChange={onChange} />;
  }

  const items = Array.isArray(value) ? (value as unknown[]) : [];
  return (
    <div className="cfg-array-grid">
      {items.map((item, i) => (
        <div key={i} className="cfg-array-grid__row">
          <ScalarInput
            elemType={elemType}
            value={item}
            onChange={(v) => {
              const next = [...items];
              next[i] = v;
              onChange(next);
            }}
          />
          <button
            type="button"
            className="cfg-row-action-btn"
            title="Remove element"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            <ClearIcon />
          </button>
        </div>
      ))}
      <AddButton title="Add element" onClick={() => onChange([...items, defaultScalar(elemType)])}>
        +
      </AddButton>
    </div>
  );
}
