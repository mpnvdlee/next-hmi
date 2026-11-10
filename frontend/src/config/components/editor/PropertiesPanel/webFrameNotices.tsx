import './webFrameNotices.css';
import type { ReactNode } from 'react';
import Button from '../../ui/Button';
import { getPropertySource, propertyValuePreview, unwrapStatic } from '../propertyValueUtils';

/** The origin a URL loads from, or null when it has none of its own. The Web
 *  Frame widget sends its outbound value by the same rule; it cannot import
 *  this one, since a built-in widget imports nothing. */
function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** The value a field holds when the project fixes it; undefined when a source
 *  computes it. */
function fixedValue(value: unknown): unknown {
  return getPropertySource(value) === 'static' ? unwrapStatic(value) : undefined;
}

function mono(text: string): ReactNode {
  return <span className="cfg-font-mono">{text}</span>;
}

/**
 * What the properties panel says under a Web Frame's URL and origin fields:
 * the settings that let another site run On Message, receive the outbound
 * value, or take over the panel. Project validation reports the same cases
 * (`webframe-*` in `backend/core/validation/structure.py`).
 */
export function webFrameNotices(
  properties: Record<string, unknown>,
  patchProp: (key: string, value: unknown) => void,
): Partial<Record<string, ReactNode>> {
  const notices: Partial<Record<string, ReactNode>> = {};
  const url = properties.url;
  const urlIsFixed = getPropertySource(url) === 'static';
  const fixedUrl = fixedValue(url);
  const origin = typeof fixedUrl === 'string' ? originOf(fixedUrl) : null;

  if (!urlIsFixed && fixedValue(properties.enableSandbox) === false) {
    notices.url = (
      <div className="cfg-ds-props__warning cfg-webframe-notice" role="status">
        <span>
          {getPropertySource(url) === '$var'
            ? 'The URL comes from a variable'
            : 'The URL is not fixed'}{' '}
          and the sandbox is off. Whoever can change {mono(propertyValuePreview(url))} decides which
          site this panel shows, with full access to its messages.
        </span>
        <Button
          type="button"
          variant="neutral"
          size="sm"
          onClick={() => patchProp('enableSandbox', true)}
        >
          Turn on sandbox
        </Button>
      </div>
    );
  }

  const outbound = fixedValue(properties.outboundOrigin);
  const outboundText = typeof outbound === 'string' ? outbound.trim() : '';
  if (
    getPropertySource(properties.outboundOrigin) === 'static' &&
    (!outboundText || outboundText === '*')
  ) {
    const target = !urlIsFixed ? (
      'The origin the URL has when the value is sent. The outbound value goes to no other site.'
    ) : origin ? (
      <>Now {mono(origin)}. The outbound value goes to no other site.</>
    ) : (
      'The URL has no origin of its own, so the outbound value is not sent.'
    );
    notices.outboundOrigin = (
      <>
        {outboundText === '*' && (
          <div className="cfg-ds-props__warning cfg-webframe-notice" role="status">
            “*” would send the value to whatever site the frame shows, so it goes to the origin of
            the URL instead. Clear the field, or name the site.
          </div>
        )}
        <span className="cfg-webframe-hint">{target}</span>
      </>
    );
  }

  const allowed = fixedValue(properties.allowedOrigins);
  // `null` lets in as much as `*`: it is the origin of any page in a sandbox
  // without allow-same-origin, whichever site that page is.
  const refused =
    typeof allowed === 'string'
      ? allowed
          .split(',')
          .map((entry) => entry.trim())
          .find((entry) => entry === '*' || entry === 'null')
      : undefined;
  if (refused) {
    notices.allowedOrigins = (
      <span className="cfg-ds-props__error" role="alert">
        “{refused}” is not allowed: every message runs On Message and writes to a variable. List the
        sites that may send messages
        {origin && <>, such as {mono(origin)}</>}.
      </span>
    );
  }

  return notices;
}
