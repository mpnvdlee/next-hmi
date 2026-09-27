import { Link, useLocation } from 'react-router-dom';
import { isInsecureOrigin } from '@shared/utils/runtimeBase';
import './style.css';

const SETTINGS_PATH = '/settings';

/**
 * Standing notice on the manager dashboard while this device answers on plain
 * HTTP at a network address. It states the fact and names the switch rather
 * than pressing it: the same setup is routine on a sealed machine network and
 * wrong on an office LAN, and only the operator knows which one this is.
 */
export default function InsecureConnectionNotice() {
  // The switch is already on the settings page, so a link there would point at
  // the page it is standing on.
  const switchIsElsewhere = useLocation().pathname !== SETTINGS_PATH;

  if (!isInsecureOrigin()) return null;

  return (
    <div className="cfg-insecure-notice">
      <span className="cfg-insecure-notice__text">
        This device is serving over the network without HTTPS, so sign-ins and project data cross it
        in the clear.
      </span>
      {switchIsElsewhere && (
        <Link className="cfg-insecure-notice__link" to={SETTINGS_PATH}>
          Turn on HTTPS in Settings
        </Link>
      )}
    </div>
  );
}
