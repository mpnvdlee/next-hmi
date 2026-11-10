import type { ProjectCode } from '@config/store/projectsStore';
import './projectForm.css';

const KINDS = [
  ['customWidgets', 'custom widget', 'custom widgets'],
  ['externalLibraries', 'external library', 'external libraries'],
  ['importOverrides', 'import-map override', 'import-map overrides'],
] as const;

/** `2 custom widgets, 1 external library`; empty when the project carries none. */
function describeProjectCode(code: ProjectCode): string {
  return KINDS.filter(([kind]) => code[kind].length > 0)
    .map(([kind, one, many]) => `${code[kind].length} ${code[kind].length === 1 ? one : many}`)
    .join(', ');
}

/** Each item as the operator would find it in the project folder. */
function codeItems(code: ProjectCode): string[] {
  return [
    ...code.customWidgets,
    ...code.externalLibraries.map((name) => `external-libraries/${name}`),
    ...code.importOverrides.map((key) => `external-modules.json: ${key}`),
  ];
}

interface Props {
  /** What the project carries; `null` when that is not known. */
  code: ProjectCode | null;
  /** The opening sentence when `code` names nothing. */
  unknownLead: string;
  /** The closing advice, e.g. "Only import projects from a source you trust." */
  closing: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}

/** The trust question asked before a project's code is installed here. */
export default function ProjectCodeWarning({
  code,
  unknownLead,
  closing,
  checked,
  disabled,
  onChange,
}: Props) {
  const summary = code ? describeProjectCode(code) : '';
  const items = code ? codeItems(code) : [];
  const lead = summary ? `This project contains code: ${summary}.` : unknownLead;
  return (
    <div className="project-form__warning">
      <p className="project-form__warning-text">
        {`${lead} It runs in the browser of everyone who opens the project, with the same access as this dashboard. ${closing}`}
      </p>
      {items.length > 0 && (
        <ul className="project-form__warning-list">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      <label className="project-form__toggle">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>I trust the source of this project and want to run its code</span>
      </label>
    </div>
  );
}
