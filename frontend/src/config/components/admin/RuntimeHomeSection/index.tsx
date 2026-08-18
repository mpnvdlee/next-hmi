import AdminSection from '../AdminSection';
import ReadOnlyValue from '../../ui/ReadOnlyValue';
import { ContentSpinner } from '@shared/components/Spinner';
import './style.css';

interface RuntimeHomeStatus {
  path: string;
}

interface Props {
  status: RuntimeHomeStatus | null;
}

export default function RuntimeHomeSection({ status }: Props) {
  if (!status) {
    return (
      <AdminSection title="Runtime home">
        <ContentSpinner variant="cfg" />
      </AdminSection>
    );
  }

  return (
    <AdminSection title="Runtime home">
      <p className="cfg-admin-runtime-home-card__desc">
        Where this installation keeps its project manifest (<code>projects.json</code>), logs, and
        the compiled custom-widget bundle. Fixed by the host environment — move it by editing
        <code> NEXTHMI_DATA_DIR</code> (Docker) or the bootstrap config file.
      </p>
      <ReadOnlyValue mono block>
        {status.path}
      </ReadOnlyValue>
    </AdminSection>
  );
}
