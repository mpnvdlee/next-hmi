import './style.css';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'success' | 'neutral' | 'accent' | 'ghost' | 'icon';
  size?: 'sm' | 'md';
  fullWidth?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', fullWidth = false, className = '', children, ...rest },
  ref,
) {
  const cls = [
    'cfg-btn',
    variant !== 'default' && `cfg-btn--${variant}`,
    size === 'sm' && 'cfg-btn--sm',
    fullWidth && 'cfg-btn--full',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button ref={ref} className={cls} {...rest}>
      {children}
    </button>
  );
});

export default Button;
