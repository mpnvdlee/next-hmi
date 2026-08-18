import { useState } from 'react';
import './style.css';
import ConfigWorkspace from '../../ui/ConfigWorkspace';
import HeaderSearch from '../../ui/HeaderSearch';
import SearchHighlight from '../../ui/SearchHighlight';
import type { Language } from '@shared/store/translationStore';

interface Props {
  languages: Language[];
  filtered: string[];
  translations: Record<string, Record<string, string>>;
  newRow: Record<string, string>;
  addError: string | null;
  filter: string;
  onUpdateCell: (key: string, lang: string, value: string) => void;
  onDeleteKey: (key: string) => void;
  onSetNewRowValue: (lang: string, value: string) => void;
  onSubmitNewRow: () => void;
  onRemoveLanguage: (lang: Language) => void;
  onFilterChange: (value: string) => void;
}

function HighlightedTranslationInput({
  value,
  query,
  onChange,
}: {
  value: string;
  query: string;
  onChange: (value: string) => void;
}) {
  const [scrollLeft, setScrollLeft] = useState(0);

  return (
    <span className="cfg-trans-highlight-input">
      <span className="cfg-trans-highlight-input__text" aria-hidden="true">
        <span
          className="cfg-trans-highlight-input__text-content"
          style={{ transform: `translateX(-${scrollLeft}px)` }}
        >
          <SearchHighlight text={value} query={query} />
        </span>
      </span>
      <input
        className="cfg-prop-input cfg-prop-input--compact cfg-trans-highlight-input__input"
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </span>
  );
}

export default function TranslationsTable({
  languages,
  filtered,
  translations,
  newRow,
  addError,
  filter,
  onUpdateCell,
  onDeleteKey,
  onSetNewRowValue,
  onSubmitNewRow,
  onRemoveLanguage,
  onFilterChange,
}: Props) {
  return (
    <ConfigWorkspace
      title="Translations"
      actions={
        <HeaderSearch
          value={filter}
          onChange={onFilterChange}
          placeholder="Search translations…"
          ariaLabel="Search translations"
        />
      }
    >
      {/* ── Table ────────────────────────────────────────────── */}
      <div className="cfg-table-wrap">
        {addError && <div className="cfg-trans-add-error">{addError}</div>}
        <table className="cfg-table cfg-trans-table">
          <thead>
            <tr>
              {languages.map((lang) => (
                <th key={lang.code} className="cfg-th cfg-trans-th--lang">
                  <span className="cfg-trans-lang-header">
                    <span className="cfg-trans-lang-header__label">{lang.code}</span>
                    {languages.length > 1 && languages[0].code !== lang.code && (
                      <button
                        className="cfg-trans-lang-remove cfg-icon-reset cfg-inline-flex-center cfg-icon-btn--sm"
                        title={`Remove ${lang.code}`}
                        onClick={() => onRemoveLanguage(lang)}
                      >
                        ×
                      </button>
                    )}
                  </span>
                </th>
              ))}
              <th className="cfg-th cfg-th--actions"></th>
            </tr>
          </thead>
          <tbody>
            {/* ── Add translation row ────────────────────────────── */}
            <tr
              className="cfg-row"
              onMouseLeave={() => {
                onSubmitNewRow();
              }}
            >
              {languages.map((lang, i) => (
                <td key={lang.code} className="cfg-td">
                  <input
                    className="cfg-prop-input cfg-prop-input--compact"
                    type="text"
                    placeholder={i === 0 ? '+ Add translation…' : ''}
                    value={newRow[lang.code] ?? ''}
                    onChange={(e) => onSetNewRowValue(lang.code, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onSubmitNewRow();
                    }}
                  />
                </td>
              ))}
              <td className="cfg-td cfg-trans-td--actions"></td>
            </tr>
            {/* ── Translation rows ─────────────────────────────── */}
            {filtered.map((key) => (
              <tr key={key} className="cfg-row cfg-row--enabled">
                {languages.map((lang, i) => (
                  <td key={lang.code} className="cfg-td">
                    {i === 0 ? (
                      <span
                        className="cfg-trans-key-text"
                        title="Immutable translation key"
                        aria-label={`Translation key: ${key}`}
                      >
                        <SearchHighlight text={key} query={filter} />
                      </span>
                    ) : (
                      <HighlightedTranslationInput
                        value={translations[key]?.[lang.code] ?? ''}
                        query={filter}
                        onChange={(value) => onUpdateCell(key, lang.code, value)}
                      />
                    )}
                  </td>
                ))}
                <td className="cfg-td cfg-trans-td--actions">
                  <button
                    className="cfg-delete-btn"
                    title="Delete translation"
                    onClick={() => onDeleteKey(key)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={languages.length + 1} className="cfg-table-empty">
                  {filter
                    ? 'No translations match the search.'
                    : 'No translations yet. Click "+ Translation" to add one.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </ConfigWorkspace>
  );
}
