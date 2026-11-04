import { useEffect } from 'react';
import { enterpriseAdminSections } from '@enterprise';
import { useAdminViewStore } from '../store/adminViewStore';
import ScrollPage from '../components/ui/ScrollPage';
import SubscriptionsSection from '../components/admin/SubscriptionsSection';
import CustomWidgetsSection from '../components/admin/CustomWidgetsSection';
import ConnectedRuntimesSection from '../components/admin/ConnectedRuntimesSection';
import HttpOriginsSection from '../components/admin/HttpOriginsSection';
import TokensSection from '../components/admin/TokensSection';
import ConfigWorkspace from '../components/ui/ConfigWorkspace';
import { getArea, projectSlug } from '@shared/utils/runtimeBase';

export default function AdminView() {
  // Tokens are minted by the manager, which only serves the editor under /editor/<id>/.
  const projectId = getArea() === 'editor' ? projectSlug() : null;
  const customWidgets = useAdminViewStore((s) => s.customWidgets);
  const subscriptions = useAdminViewStore((s) => s.subscriptions);
  const alarmTriggers = useAdminViewStore((s) => s.alarmTriggers);
  const historianPaths = useAdminViewStore((s) => s.historianPaths);
  const runtimes = useAdminViewStore((s) => s.runtimes);
  const runtimesLoading = useAdminViewStore((s) => s.runtimesLoading);
  const runtimesError = useAdminViewStore((s) => s.runtimesError);
  const recompiling = useAdminViewStore((s) => s.recompiling);
  const recompileError = useAdminViewStore((s) => s.recompileError);
  const loadCustomWidgets = useAdminViewStore((s) => s.loadCustomWidgets);
  const loadSubscriptions = useAdminViewStore((s) => s.loadSubscriptions);
  const loadRuntimes = useAdminViewStore((s) => s.loadRuntimes);
  const recompileAllWidgets = useAdminViewStore((s) => s.recompileAllWidgets);
  const recompileWidget = useAdminViewStore((s) => s.recompileWidget);
  const httpOrigins = useAdminViewStore((s) => s.httpOrigins);
  const httpOriginsError = useAdminViewStore((s) => s.httpOriginsError);
  const loadHttpOrigins = useAdminViewStore((s) => s.loadHttpOrigins);
  const saveHttpOrigins = useAdminViewStore((s) => s.saveHttpOrigins);

  useEffect(() => {
    void loadCustomWidgets();
    void loadSubscriptions();
    void loadRuntimes();
    void loadHttpOrigins();
    const subId = setInterval(loadSubscriptions, 2000);
    return () => {
      clearInterval(subId);
    };
  }, [loadCustomWidgets, loadSubscriptions, loadRuntimes, loadHttpOrigins]);

  return (
    <ConfigWorkspace title="Admin" flush>
      <ScrollPage>
        <SubscriptionsSection
          subscriptions={subscriptions}
          alarmTriggers={alarmTriggers}
          historianPaths={historianPaths}
        />
        <CustomWidgetsSection
          widgets={customWidgets}
          recompiling={recompiling}
          error={recompileError}
          onRecompileAll={recompileAllWidgets}
          onRecompile={recompileWidget}
        />
        <ConnectedRuntimesSection
          runtimes={runtimes}
          loading={runtimesLoading}
          error={runtimesError}
          onRefresh={loadRuntimes}
        />
        <HttpOriginsSection
          origins={httpOrigins}
          error={httpOriginsError}
          onSave={saveHttpOrigins}
        />
        {projectId && <TokensSection projectId={projectId} />}
        {enterpriseAdminSections.map((Section, i) => (
          <Section key={i} />
        ))}
      </ScrollPage>
    </ConfigWorkspace>
  );
}
