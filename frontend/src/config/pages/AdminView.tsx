import { useEffect } from 'react';
import { enterpriseAdminSections } from '@enterprise';
import { useAdminViewStore } from '../store/adminViewStore';
import ScrollPage from '../components/ui/ScrollPage';
import SubscriptionsSection from '../components/admin/SubscriptionsSection';
import CustomWidgetsSection from '../components/admin/CustomWidgetsSection';
import ConnectedRuntimesSection from '../components/admin/ConnectedRuntimesSection';
import ConfigWorkspace from '../components/ui/ConfigWorkspace';

export default function AdminView() {
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

  useEffect(() => {
    void loadCustomWidgets();
    void loadSubscriptions();
    void loadRuntimes();
    const subId = setInterval(loadSubscriptions, 2000);
    return () => {
      clearInterval(subId);
    };
  }, [loadCustomWidgets, loadSubscriptions, loadRuntimes]);

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
        {enterpriseAdminSections.map((Section, i) => (
          <Section key={i} />
        ))}
      </ScrollPage>
    </ConfigWorkspace>
  );
}
