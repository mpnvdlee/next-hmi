import './style.css';
import LogoMark from '@shared/components/LogoMark';
import Spinner from '@shared/components/Spinner';
import { useConfigStore } from '@shared/store/configStore';
import type { CSSWithVars } from '@shared/types/style';
import { imageBodyToUrl } from '@shared/utils/imageAsset';
import { getEdition, getVersion } from '@shared/utils/runtimeBase';

const SOURCE_URL = 'https://next-hmi.com';

/** Boot phases, in order. Drives the progress readout. */
const PHASES = ['components', 'config', 'ready'] as const;
export type BootPhase = (typeof PHASES)[number];

const PHASE_LABELS: Record<BootPhase, string> = {
  components: 'Loading components',
  config: 'Loading configuration',
  ready: 'Starting runtime',
};

/**
 * Full-screen boot screen for the HMI runtime: branding, version, spinner,
 * progress and the open-source attribution notice in one surface.
 *
 * The AGPL source-availability sentence is edition-bound, not settings-bound:
 * it states the terms the *public* build ships under, so no project setting
 * hides it and the `ee` build (which ships under the commercial licence
 * instead) omits it. Shortening the two-second minimum in `bootHold.ts`, or
 * white-labelling without a commercial licence, is a licence violation rather
 * than a technical impossibility. See COMMERCIAL.md and LICENSING.md.
 *
 * `shell.bootLogo` replaces the product mark and name with the project's own
 * logo. Edition-bound the same way: the public build ignores the key entirely,
 * so carrying a white-labelled project over to it shows the product branding
 * back. Not a licence check — a project setting the oss build has no surface
 * for and no reader of.
 *
 * Branding is held back until the project config has loaded, so a white-labelled
 * project never flashes the NEXT HMI mark on its way up.
 */
export default function BootSplash({ phase }: { phase: BootPhase }) {
  const configLoaded = useConfigStore((s) => s.loaded);
  const bootLogo = useConfigStore((s) => s.shell.bootLogo);

  const step = PHASES.indexOf(phase) + 1;
  const progressStyle: CSSWithVars = {
    '--hmi-boot-progress': `${Math.round((step / PHASES.length) * 100)}%`,
  };

  const isEE = getEdition() === 'ee';
  const logoUrl = isEE && bootLogo ? imageBodyToUrl({ path: bootLogo }) : null;
  const showAgplNotice = configLoaded && !isEE;

  return (
    <div className="hmi-boot-splash" role="status" aria-live="polite">
      <div className="hmi-boot-splash__panel">
        <div className="hmi-boot-splash__brand">
          {configLoaded &&
            (logoUrl ? (
              <img className="hmi-boot-splash__logo" src={logoUrl} alt="" />
            ) : (
              <>
                <LogoMark className="hmi-boot-splash__mark" />
                <span className="hmi-boot-splash__title">
                  <span className="hmi-boot-splash__title-next">NEXT</span> HMI
                </span>
              </>
            ))}
          <span className="hmi-boot-splash__version">v{getVersion()}</span>
        </div>

        <Spinner variant="cfg" />

        <div className="hmi-boot-splash__progress">
          <div className="hmi-boot-splash__track">
            <div className="hmi-boot-splash__bar" style={progressStyle} />
          </div>
          <span className="hmi-boot-splash__step">
            {PHASE_LABELS[phase]} · {step}/{PHASES.length}
          </span>
        </div>

        <p className="hmi-boot-splash__notice">
          {showAgplNotice && (
            <>
              Free and open-source software licensed under AGPL-3.0. Complete source code is
              available at{' '}
              <a
                className="hmi-boot-splash__link"
                href={SOURCE_URL}
                target="_blank"
                rel="noreferrer"
              >
                next-hmi.com
              </a>
              .
            </>
          )}
        </p>
      </div>
    </div>
  );
}
