import ScrollPage from '../components/ui/ScrollPage';
import HistorianConfig from '../components/historian/HistorianConfig';
import ConfigWorkspace from '../components/ui/ConfigWorkspace';

export default function HistorianView() {
  return (
    <ConfigWorkspace title="Historian" flush>
      <ScrollPage>
        <HistorianConfig />
      </ScrollPage>
    </ConfigWorkspace>
  );
}
