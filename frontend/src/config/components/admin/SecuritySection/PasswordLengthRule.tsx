import GlyphIcon from '@config/components/ui/glyphIcon';
import { MIN_ADMIN_PASSWORD_LENGTH, passwordLength } from './passwordRule';
import './style.css';

interface Props {
  id: string;
  password: string;
}

/** The rule for a new device-admin password, checked as it is typed. */
export default function PasswordLengthRule({ id, password }: Props) {
  const typed = passwordLength(password);
  const met = typed >= MIN_ADMIN_PASSWORD_LENGTH;
  const state = met ? ' cfg-password-rule--met' : typed > 0 ? ' cfg-password-rule--unmet' : '';
  // Hand-drawn glyphs: the manager route stays clear of the icon library chunk.
  return (
    <span id={id} className={`cfg-password-rule${state}`}>
      <GlyphIcon width={14} height={14} strokeWidth={2}>
        <path d={met ? 'M3.5 8.5 L6.5 11.5 L12.5 4.5' : 'M4 4 L12 12 M12 4 L4 12'} />
      </GlyphIcon>
      At least {MIN_ADMIN_PASSWORD_LENGTH} characters
      {!met && typed > 0 && ` (${typed} of ${MIN_ADMIN_PASSWORD_LENGTH})`}
    </span>
  );
}
