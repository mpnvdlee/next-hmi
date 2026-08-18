import Button from '../../ui/Button';
import AdminSection from '../AdminSection';

interface Props {
  onOpen: () => void;
}

export default function LogsSection({ onOpen }: Props) {
  return (
    <AdminSection title="Logs">
      <p className="cfg-admin-section__desc">
        View the most recent backend log entries. The file rotates at 5 MB and is kept on disk
        outside the project workspace.
      </p>
      <div>
        <Button onClick={onOpen}>View logs</Button>
      </div>
    </AdminSection>
  );
}
