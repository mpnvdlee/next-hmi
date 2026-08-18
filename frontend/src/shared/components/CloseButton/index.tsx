import type { ButtonHTMLAttributes } from 'react';
import styles from './style.module.css';

interface CloseButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
> {
  label?: string;
  tone?: 'hmi' | 'config' | 'inverse';
}

/** The single close/dismiss control used across runtime and configuration UI. */
export default function CloseButton({
  label = 'Close',
  tone = 'hmi',
  className = '',
  type = 'button',
  ...buttonProps
}: CloseButtonProps) {
  const classes = [styles.button, styles[tone], className].filter(Boolean).join(' ');

  return (
    <button {...buttonProps} type={type} className={classes} aria-label={label}>
      <span aria-hidden="true">×</span>
    </button>
  );
}
