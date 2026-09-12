import './newProjectTemplateModal.css';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import examplePreview from './example-preview.png';

export type ProjectTemplate = 'empty' | 'example';

interface Props {
  onCancel(): void;
  onChoose(template: ProjectTemplate): void;
}

export default function NewProjectTemplateModal({ onCancel, onChoose }: Props) {
  return (
    <ModalShell onClose={onCancel} dialogClassName="template-modal cfg-flex-col">
      <div className="name-modal__title">Start a new project</div>
      <div className="template-modal__options">
        <button
          type="button"
          className="template-card"
          onClick={() => onChoose('empty')}
        >
          <span className="template-card__art" aria-hidden="true" />
          <span className="template-card__name">Empty project</span>
          <span className="template-card__note">One blank page. Build it your way.</span>
        </button>
        <button
          type="button"
          className="template-card"
          onClick={() => onChoose('example')}
        >
          <img className="template-card__art" src={examplePreview} alt="" />
          <span className="template-card__name">NEXT BREW example</span>
          <span className="template-card__note">
            A working demo machine — pages, alarms, recipes and themes to pull apart.
          </span>
        </button>
      </div>
      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </ModalShell>
  );
}
