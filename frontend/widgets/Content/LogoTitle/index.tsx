/* @jsxRuntime classic */
export const schema = {
  logoUrl: { type: 'image' as const, label: 'Logo image', group: 'Content' },
  title: {
    type: 'string' as const,
    label: 'Title',
    group: 'Content',
    defaultValue: 'NEXT HMI',
  },
  subtitle: { type: 'string' as const, label: 'Subtitle', group: 'Content' },
};

export const displayName = 'Logo Title';
export const description = 'A logo image paired with a title and an optional subtitle.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'image-square' } as const;

export default function LogoTitle({ properties, layout }: HmiWidgetProps) {
  const title = usePropString(properties, 'title', 'NEXT HMI');
  const subtitle = usePropString(properties, 'subtitle', '');
  const logoUrl = usePropString(properties, 'logoUrl', '');

  return (
    <div className="hmi-component hmi-logo-title" style={selfLayoutStyle(layout)}>
      {logoUrl && <img className="hmi-logo-title__logo" src={logoUrl} alt="Logo" />}
      <div className="hmi-logo-title__text">
        <span className="hmi-logo-title__title">{title}</span>
        {subtitle && <span className="hmi-logo-title__subtitle">{subtitle}</span>}
      </div>
    </div>
  );
}
