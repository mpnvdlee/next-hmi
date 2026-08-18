/* @jsxRuntime classic */
export const schema = {
  label: { type: 'string' as const, label: 'Label', defaultValue: 'Language' },
};

export const displayName = 'Language Switcher';
export const description = 'Lets operators change the interface language.';
export const category = 'Navigation';
export const icon = { type: 'builtin', name: 'translate' } as const;

export default function LanguageSwitcher({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const languages = useLanguagesData();
  const { activeLanguage, setActiveLanguage } = useLanguageSelection();
  const label = getPropString(properties, 'label', 'Language', evalCtx);

  const fallbackCode = activeLanguage || languages[0]?.code || 'default';

  return (
    <label className="hmi-component hmi-language-switcher" style={selfLayoutStyle(layout)}>
      <span className="hmi-language-switcher__label">{label}</span>
      <select
        className="hmi-language-switcher__select"
        value={fallbackCode}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setActiveLanguage(e.target.value)}
      >
        {languages.length > 0 ? (
          languages.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.code}
            </option>
          ))
        ) : (
          <option value="default">default</option>
        )}
      </select>
    </label>
  );
}
