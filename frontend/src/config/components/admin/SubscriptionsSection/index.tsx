import { useState } from 'react';
import { Bell, ChartLine } from '@phosphor-icons/react';
import AdminSection from '../AdminSection';
import type { SubscriptionEntry } from '../../../store/adminViewStore';
import './style.css';

interface Props {
  subscriptions: Record<string, SubscriptionEntry>;
  alarmTriggers: Record<string, string[]>;
  historianPaths: Record<string, string[]>;
}

export default function SubscriptionsSection({
  subscriptions,
  alarmTriggers,
  historianPaths,
}: Props) {
  const [expandedLeaves, setExpandedLeaves] = useState<Record<string, boolean>>({});

  return (
    <AdminSection title="Fast Subscriptions">
      {Object.keys(subscriptions).length === 0 ? (
        <p className="cfg-empty">No OPC-UA datasources active.</p>
      ) : (
        <div className="cfg-admin-subscription-list cfg-flex-col">
          {Object.entries(subscriptions).map(([dsName, entry]) => {
            const leavesOpen = expandedLeaves[dsName] ?? false;
            const leafPaths = entry.priority_leaf_paths ?? [];
            const alarmSet = new Set(alarmTriggers[dsName] ?? []);
            const historianSet = new Set(historianPaths[dsName] ?? []);
            // Every path on the fast subscription, shown once each. priority_paths
            // is already the merged set (page-driven + alarm + historian); union in
            // the alarm/historian sets too so they still show while disconnected.
            const allPaths = Array.from(
              new Set([...entry.priority_paths, ...alarmSet, ...historianSet]),
            ).sort();
            return (
              <div key={dsName} className="cfg-admin-subscription-card cfg-card">
                <div className="cfg-admin-subscription-card__header">
                  <span className="cfg-admin-subscription-card__name">{dsName}</span>
                  <span
                    className={`cfg-badge ${entry.connected ? 'cfg-badge--ok' : 'cfg-badge--error'}`}
                  >
                    {entry.connected ? 'Connected' : 'Disconnected'}
                  </span>
                  <span
                    className={`cfg-badge ${entry.bg_enabled ? 'cfg-badge--ok' : 'cfg-badge--unknown'}`}
                  >
                    BG {entry.bg_enabled ? 'On' : 'Off'}
                  </span>
                </div>
                <p className="cfg-admin-subscription-card__count">
                  {allPaths.length} fast
                  {leafPaths.length > 0 ? ` (${leafPaths.length} expanded leaves)` : ''}
                </p>

                {/* All fast paths, each shown once; icons mark why it's subscribed */}
                {allPaths.length === 0 ? (
                  <span className="cfg-admin-subscription-card__empty">No fast subscriptions</span>
                ) : (
                  <div className="cfg-admin-subscription-card__paths">
                    {allPaths.map((p) => {
                      const isAlarm = alarmSet.has(p);
                      const isHistorian = historianSet.has(p);
                      const title =
                        [isAlarm && 'Alarm trigger', isHistorian && 'Historized']
                          .filter(Boolean)
                          .join(' · ') || undefined;
                      return (
                        <span
                          key={p}
                          className="cfg-admin-subscription-card__path cfg-admin-subscription-card__path--priority"
                          title={title}
                        >
                          {dsName}:{p}
                          {isAlarm && (
                            <Bell size={11} className="cfg-admin-subscription-card__path-icon" />
                          )}
                          {isHistorian && (
                            <ChartLine
                              size={11}
                              className="cfg-admin-subscription-card__path-icon"
                            />
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* Priority leaf paths — only shown when binding paths expand to child leaves */}
                {leafPaths.length > 0 && (
                  <div className="cfg-admin-subscription-card__bg-section">
                    <button
                      className="cfg-admin-subscription-card__bg-toggle"
                      onClick={() =>
                        setExpandedLeaves((prev) => ({ ...prev, [dsName]: !leavesOpen }))
                      }
                    >
                      {leavesOpen ? '▾' : '▸'} Priority leaves ({leafPaths.length})
                    </button>
                    {leavesOpen && (
                      <div className="cfg-admin-subscription-card__paths">
                        {leafPaths.map((p) => (
                          <span
                            key={p}
                            className="cfg-admin-subscription-card__path cfg-admin-subscription-card__path--priority"
                          >
                            {dsName}:{p}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </AdminSection>
  );
}
