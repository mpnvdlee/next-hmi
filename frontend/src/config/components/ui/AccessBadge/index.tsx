import './style.css';

interface Props {
  writable?: boolean | null;
  showUnknown?: boolean;
  unknownLabel?: string;
  readOnlyLabel?: string;
  readWriteLabel?: string;
  onClick?: () => void;
}

export default function AccessBadge({
  writable,
  showUnknown = false,
  unknownLabel = '—',
  readOnlyLabel = 'RO',
  readWriteLabel = 'RW',
  onClick,
}: Props) {
  const label =
    writable === false
      ? readOnlyLabel
      : writable === true
        ? readWriteLabel
        : showUnknown
          ? unknownLabel
          : null;

  if (label === null) return null;

  const modifier =
    writable === false
      ? 'cfg-badge--ro'
      : writable === true
        ? 'cfg-badge--rw'
        : 'cfg-badge--unknown';

  const cls = `cfg-badge cfg-access-badge ${modifier}${onClick ? ' cfg-access-badge--interactive' : ''}`;

  return onClick ? (
    <button type="button" className={cls} onClick={onClick}>
      {label}
    </button>
  ) : (
    <span className={cls}>{label}</span>
  );
}
