import PropRow from '../../../ui/PropRow';
import Select from '../../../ui/Select';
import { WildcardCard } from './shared';
import { ParentPathContext, useParentPath, withSegs } from '../parentPathContext';
import { wrapPicker, type OpenBindingPicker } from './utils';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { HttpSource } from '@shared/types/config';
import type { PropertySource } from '../../propertyValueUtils';

/**
 * Sub-editor for the `$http` source: an HTTP request whose url and body are
 * `$stringExpr`-style templates, plus a slash-path that picks one value out of
 * the JSON response.
 */

/** Extract unique wildcard numbers from every template on the request. */
function extractWildcardKeys(templates: string[]): string[] {
  const keys = new Set<string>();
  const re = /\{([^{}]+)\}/g;
  for (const template of templates) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(template)) !== null) {
      let body = m[1].trim();
      while (true) {
        const fn = /^[A-Za-z]\w*\((.+)\)$/.exec(body);
        if (!fn) break;
        body = fn[1].trim();
      }
      if (/^\d+$/.test(body)) keys.add(body);
    }
  }
  return Array.from(keys).sort((a, b) => Number(a) - Number(b));
}

const WILDCARD_SOURCES: PropertySource[] = ['static', '$var', '$loc'];
const WILDCARD_SCHEMA: SchemaField = { type: 'String', label: '' };

type HttpPayload = HttpSource['$http'];

const EMPTY: HttpPayload = { url: '', wildcards: {}, method: 'GET', path: '', refreshSeconds: 0 };

export function HttpEditor({
  value,
  onChange,
  onOpenBindingPicker,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  onOpenBindingPicker?: OpenBindingPicker;
}) {
  const parent = useParentPath();
  const http = (value as HttpSource)?.$http ?? EMPTY;
  const wildcards: Record<string, unknown> = http.wildcards ?? {};
  const method = http.method ?? 'GET';

  const keys = extractWildcardKeys([http.url ?? '', http.body ?? '']);

  function patch(next: Partial<HttpPayload>) {
    onChange({ $http: { ...http, ...next } });
  }

  /** Drop wildcard bindings whose placeholder no longer appears in a template. */
  function patchTemplates(next: Partial<HttpPayload>) {
    const merged = { ...http, ...next };
    const live = new Set(extractWildcardKeys([merged.url ?? '', merged.body ?? '']));
    const kept: Record<string, unknown> = {};
    for (const k of live) kept[k] = wildcards[k] ?? '';
    onChange({ $http: { ...merged, wildcards: kept } });
  }

  return (
    <div className="cfg-http-source">
      <PropRow label="Method" tier={2}>
        <Select value={method} onChange={(v) => patch({ method: v as 'GET' | 'POST' })}>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
        </Select>
      </PropRow>

      <PropRow label="URL" block>
        <input
          className="cfg-prop-input"
          type="text"
          value={http.url ?? ''}
          onChange={(e) => patchTemplates({ url: e.target.value })}
          placeholder="https://api.example.com/devices/{1}/status"
        />
      </PropRow>

      <p className="cfg-prop-hint">
        Use <code>{'{1}'}</code>, <code>{'{2}'}</code>, … anywhere in the URL or body, then bind
        each placeholder below. The same functions as a string expression apply —{' '}
        <code>{'{ToLower(1)}'}</code>.
      </p>

      {method === 'POST' && (
        <PropRow label="Body" block>
          <textarea
            className="cfg-prop-input cfg-http-body"
            value={http.body ?? ''}
            onChange={(e) => patchTemplates({ body: e.target.value })}
            placeholder={'{"deviceId": "{1}"}'}
            rows={3}
          />
        </PropRow>
      )}

      <PropRow
        label="Response Path"
        description="Slash-path into the JSON response — leave empty for the whole body."
        block
      >
        <input
          className="cfg-prop-input"
          type="text"
          value={http.path ?? ''}
          onChange={(e) => patch({ path: e.target.value })}
          placeholder="data/0/value"
        />
      </PropRow>

      <PropRow label="Refresh (s)" description="0 fetches once and caches the response.">
        <input
          className="cfg-prop-input"
          type="number"
          min={0}
          value={http.refreshSeconds ?? 0}
          onChange={(e) => patch({ refreshSeconds: Number(e.target.value) || 0 })}
        />
      </PropRow>

      {keys.map((key) => {
        const wcValue = wildcards[key] ?? '';
        const wcPicker = wrapPicker(
          onOpenBindingPicker,
          (b) => patch({ wildcards: { ...wildcards, [key]: { $var: b } } }),
          wcValue,
        );

        const path = withSegs(parent, '$http', 'wildcards', key);
        return (
          <ParentPathContext.Provider key={key} value={path}>
            <WildcardCard
              wcKey={key}
              value={wcValue}
              onChange={(v) => patch({ wildcards: { ...wildcards, [key]: v } })}
              onOpenBindingPicker={wcPicker}
              schema={WILDCARD_SCHEMA}
              forcedSources={WILDCARD_SOURCES}
            />
          </ParentPathContext.Provider>
        );
      })}
    </div>
  );
}
