/* @jsxRuntime classic */
export const schema = {
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  options: {
    type: ['option-list', 'string[]', 'integer[]'] as const,
    label: 'Options',
    group: 'Content',
  },
  selectedValue: {
    type: 'string' as const,
    label: 'Selected value',
    description: 'Initial selection; also re-selects when the bound value changes.',
    group: 'Data',
  },
  disabled: { type: 'boolean' as const, label: 'Disabled', group: 'Appearance' },
  onChange: { type: 'actions' as const, label: 'On Change', event: 'onChange' },
};

export const exportedProperties: ExportedProperty[] = [
  { key: 'selectedValue', label: 'Selected Value', type: 'string' },
];

export const description =
  'Pick one option from a list. Publishes the selection for sibling widgets to read and fires On Change.';
export const category = 'Inputs';
export const icon = { type: 'builtin', name: 'list' } as const;

interface ItemEntry {
  label: string;
  value: string;
}

interface PopupRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

interface UserEntry {
  id: number;
  username: string;
}

/** A key event carrying the modifier flags typeahead has to ignore — wider than
 *  the SDK's `React.KeyboardEvent`, which declares only `key`. */
interface MenuKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  preventDefault(): void;
}

/** Resolve the `options` property to a usable ItemEntry array.
 *  Accepts: raw ItemEntry[] ($static), { $user: { field: 'userList' | 'groups' } },
 *  { $var: {...} } (array variable), or { $languages: {} } (language list). */
function resolveOptions(
  raw: unknown,
  users: UserEntry[],
  userGroups: Array<{ id: string; label: string }>,
  varValue: unknown,
  languages: Array<{ code: string }>,
): ItemEntry[] {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if ('$user' in obj) {
      const field = (obj.$user as Record<string, unknown>)?.field;
      if (field === 'userList') {
        return users.map((u) => ({ label: u.username, value: String(u.id) }));
      }
      if (field === 'groups') {
        return userGroups.map((group) => ({
          label: group.label,
          value: group.id,
        }));
      }
    }
    if ('$languages' in obj) {
      return languages.map((l) => ({ label: l.code, value: l.code }));
    }
    if ('$var' in obj) {
      if (Array.isArray(varValue)) {
        return varValue.map((el) => {
          if (el !== null && typeof el === 'object') {
            const entry = el as Record<string, unknown>;
            return {
              label: String(entry.label ?? entry.value ?? ''),
              value: String(entry.value ?? entry.label ?? ''),
            };
          }
          const text = el === null || el === undefined ? '' : String(el);
          return { label: text, value: text };
        });
      }
      return [];
    }
  }
  if (Array.isArray(raw)) {
    return raw.map((el) => {
      if (el !== null && typeof el === 'object') {
        const entry = el as Record<string, unknown>;
        return {
          label: String(entry.label ?? entry.value ?? ''),
          value: String(entry.value ?? entry.label ?? ''),
        };
      }
      const text = el === null || el === undefined ? '' : String(el);
      return { label: text, value: text };
    });
  }
  return [];
}

function readTriggerRect(trigger: HTMLButtonElement | null): PopupRect | null {
  if (!trigger) return null;
  const rect = trigger.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
  };
}

export default function Dropdown({ id, properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const scope = useHmiScope();
  const users = useUsersData();
  const userGroups = useUserGroupsData();
  const languages = useLanguagesData();
  const propSelectedValue = usePropString(properties, 'selectedValue', '');
  const [selected, setSelected] = useState<string>(propSelectedValue);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [popupRect, setPopupRect] = useState<PopupRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const typeahead = useRef({ buffer: '', timestamp: 0 });

  const optionsRaw = properties?.options;
  const label = getPropString(properties, 'label', '', evalCtx);
  const disabled = getPropBoolean(properties, 'disabled', false, evalCtx);

  // Resolve $var binding key for array variable source
  const varBinding = (optionsRaw as { $var?: { path: string } } | undefined)?.$var ?? null;
  const varKey = varBinding?.path ?? '';
  const varValue = useVariable(varKey);

  const options = useMemo(
    () =>
      resolveOptions(optionsRaw, users, userGroups, varValue, languages).filter(
        (option) => option.label.trim().length > 0,
      ),
    [optionsRaw, users, userGroups, varValue, languages],
  );
  const menuOptions = useMemo(() => [{ label: '—', value: '' }, ...options], [options]);
  const selectedIndex = menuOptions.findIndex((option) => option.value === selected);
  const selectedOption = selectedIndex >= 0 ? menuOptions[selectedIndex] : menuOptions[0];
  const listboxId = `hmi-dropdown-${id}-listbox`;

  // Sync selection when the selectedValue property changes externally
  useEffect(() => {
    setSelected(propSelectedValue);
  }, [propSelectedValue]);

  // Reset selection when the options list changes and the current value is no
  // longer present (e.g. switching from an int array variable to a string array).
  useEffect(() => {
    if (selected && !options.some((o: ItemEntry) => o.value === selected)) {
      setSelected('');
    }
  }, [options, selected]);

  useEffect(() => {
    if (!open) return;

    const updatePosition = () => setPopupRect(readTriggerRect(triggerRef.current));
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // menuOptions is a dependency because the popup's own width — which the
  // clamp below reads — changes with the list it renders.
  useEffect(() => {
    if (open) setPopupRect(readTriggerRect(triggerRef.current));
  }, [open, menuOptions]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const popup = popupRef.current;
    popup
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });

    if (popup) {
      const margin = 8;
      const popupWidth = popup.getBoundingClientRect().width;
      const preferredLeft = popupRect?.left ?? margin;
      const maxLeft = window.innerWidth - popupWidth - margin;
      popup.style.setProperty(
        '--hmi-dropdown-popup-left',
        `${Math.max(margin, Math.min(preferredLeft, maxLeft))}px`,
      );
    }
  }, [open, activeIndex, popupRect, menuOptions]);

  usePublishWidgetProp(id, 'selectedValue', selected);

  function openMenu(direction: 1 | -1 = 1) {
    if (disabled) return;
    const fallback = direction === 1 ? 0 : menuOptions.length - 1;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : fallback);
    setPopupRect(readTriggerRect(triggerRef.current));
    setOpen(true);
  }

  function choose(index: number) {
    // An index with no option behind it — nothing active yet, or an index left
    // pointing past a list that shrank — still dismisses: bailing out early left
    // the popup open over the page with only Escape to close it.
    const option = menuOptions[index];
    if (option && option.value !== selected) {
      setSelected(option.value);
      const actions = (properties?.onChange as ActionsConfig | undefined)?.onChange;
      executeWidgetActions(actions, { scope, evalCtx });
    }
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveActive(delta: 1 | -1) {
    setActiveIndex((current) => {
      const start = current < 0 ? (delta === 1 ? -1 : 0) : current;
      return (start + delta + menuOptions.length) % menuOptions.length;
    });
  }

  function handleKeyDown(event: MenuKeyEvent) {
    if (disabled) return;
    if (!open) {
      if (
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === ' '
      ) {
        event.preventDefault();
        openMenu(event.key === 'ArrowUp' ? -1 : 1);
      }
      return;
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(menuOptions.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(activeIndex);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const now = Date.now();
          const nextBuffer =
            now - typeahead.current.timestamp > 600
              ? event.key
              : typeahead.current.buffer + event.key;
          typeahead.current = { buffer: nextBuffer, timestamp: now };
          const query = nextBuffer.toLowerCase();
          const start = activeIndex >= 0 ? activeIndex : 0;
          for (let offset = 1; offset <= menuOptions.length; offset += 1) {
            const index = (start + offset) % menuOptions.length;
            if (menuOptions[index].label.toLowerCase().startsWith(query)) {
              setActiveIndex(index);
              break;
            }
          }
        }
        break;
    }
  }

  return (
    <>
      <div
        className={`hmi-component hmi-dropdown${disabled ? ' hmi-dropdown--disabled' : ''}`}
        style={selfLayoutStyle(layout)}
      >
        {label && <label className="hmi-dropdown__label">{label}</label>}
        <button
          ref={triggerRef}
          type="button"
          className={`hmi-dropdown__trigger${open ? ' hmi-dropdown__trigger--open' : ''}`}
          disabled={disabled}
          role="combobox"
          aria-label={label || 'Select an option'}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={
            open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
          }
          onClick={() => {
            if (open) setOpen(false);
            else openMenu();
          }}
          onKeyDown={handleKeyDown}
        >
          <span
            className={`hmi-dropdown__value${selected ? '' : ' hmi-dropdown__value--placeholder'}`}
          >
            {selectedOption.label}
          </span>
          <svg
            className="hmi-dropdown__chevron"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
          >
            <path
              d="M2 3.5 L5 6.5 L8 3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {open &&
        popupRect &&
        createPortal(
          <DropdownPopup
            listboxId={listboxId}
            rect={popupRect}
            options={menuOptions}
            selected={selected}
            activeIndex={activeIndex}
            onActivate={setActiveIndex}
            onChoose={choose}
            popupRef={popupRef}
          />,
          document.body,
        )}
    </>
  );
}

function DropdownPopup(props: {
  listboxId: string;
  rect: PopupRect;
  options: ItemEntry[];
  selected: string;
  activeIndex: number;
  onActivate: (index: number) => void;
  onChoose: (index: number) => void;
  popupRef: { current: HTMLDivElement | null };
}) {
  const { listboxId, rect, options, selected, activeIndex, onActivate, onChoose, popupRef } = props;
  const viewportHeight = window.innerHeight;
  const margin = 8;
  const spaceBelow = viewportHeight - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  const placeBelow = spaceBelow >= 200 || spaceBelow >= spaceAbove;
  const maxHeight = Math.min(320, Math.max(0, placeBelow ? spaceBelow : spaceAbove));
  // Geometry only: measured per instance from the trigger's viewport rect, so
  // it cannot live in the stylesheet. Emitted as custom properties the sheet
  // consumes, which keeps every declaration itself in style.css.
  const popupStyle: React.CSSProperties = {
    '--hmi-dropdown-popup-left': `${rect.left}px`,
    '--hmi-dropdown-popup-min-width': `${rect.width}px`,
    '--hmi-dropdown-popup-max-height': `${maxHeight}px`,
    ...(placeBelow
      ? { '--hmi-dropdown-popup-top': `${rect.bottom + 2}px` }
      : { '--hmi-dropdown-popup-bottom': `${viewportHeight - rect.top + 2}px` }),
  };

  return (
    <div
      ref={popupRef}
      id={listboxId}
      role="listbox"
      tabIndex={-1}
      className={`hmi-dropdown__popup hmi-dropdown__popup--${placeBelow ? 'below' : 'above'}`}
      style={popupStyle}
    >
      {options.map((option, index) => {
        const isSelected = option.value === selected;
        const className = [
          'hmi-dropdown__option',
          index === activeIndex && 'hmi-dropdown__option--active',
          isSelected && 'hmi-dropdown__option--selected',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div
            key={`${index}:${option.value}`}
            id={`${listboxId}-option-${index}`}
            data-index={index}
            role="option"
            aria-selected={isSelected}
            className={className}
            onMouseEnter={() => onActivate(index)}
            onMouseDown={(event: React.MouseEvent<HTMLDivElement>) => event.preventDefault()}
            onClick={() => onChoose(index)}
          >
            {option.label}
          </div>
        );
      })}
    </div>
  );
}
