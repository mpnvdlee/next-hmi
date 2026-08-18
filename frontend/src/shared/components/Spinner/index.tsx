import './style.css';

/** Which accent token the spinner draws from: the HMI runtime theme or the config/admin (backend) theme. */
type SpinnerVariant = 'hmi' | 'cfg';

interface SpinnerProps {
  size?: 'sm' | 'md';
  variant?: SpinnerVariant;
  className?: string;
}

/** The app's loading indicator, in the theme accent colour. */
export default function Spinner({ size = 'md', variant = 'hmi', className = '' }: SpinnerProps) {
  const cls = [
    'app-spinner',
    `app-spinner--${variant}`,
    size === 'sm' && 'app-spinner--sm',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <div className={cls} role="status" aria-label="Loading" />;
}

/** Spinner centred in the full viewport — for top-level route fallbacks. */
export function PageSpinner({ variant = 'hmi' }: { variant?: SpinnerVariant }) {
  return (
    <div className="app-spinner-screen">
      <Spinner variant={variant} />
    </div>
  );
}

/** Spinner centred in the available content area — for in-shell page/section bodies. */
export function ContentSpinner({ variant = 'hmi' }: { variant?: SpinnerVariant }) {
  return (
    <div className="app-spinner-fill">
      <Spinner variant={variant} />
    </div>
  );
}
