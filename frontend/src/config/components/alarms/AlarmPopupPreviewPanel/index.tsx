/**
 * AlarmPopupPreviewPanel — what the selected alarm looks like to an operator.
 *
 * Both cards are the runtime's own components rendered inert, and this view
 * pulls in the runtime stylesheet so they resolve against the HMI theme rather
 * than the config chrome. That is the point: a preview that re-implemented the
 * markup drifted from the real thing (its own stripe width, its own badge
 * colours) with nothing to catch it.
 */

import '@hmi/styles/hmi.css';
import type { AlarmConfig, AlarmDefinition } from '@shared/types/alarm';
import type { AlarmSelection } from '@config/store/alarmConfigStore';
import AlarmToastCard from '@hmi/components/AlarmPopup/AlarmToastCard';
import AlarmDetailCard from '@hmi/components/AlarmDetailDialog/AlarmDetailCard';
import { assetUrl } from '../../editor/assetPickerUtils';
import { resolveAlarmString, resolveAlarmImage, findAlarm } from '../alarmDisplayUtils';
import { useTranslationStore } from '@shared/store/translationStore';

interface Props {
  config: AlarmConfig;
  selection: AlarmSelection;
}

function alarmTitle(alarm: AlarmDefinition): string {
  return resolveAlarmString(alarm.title) || 'Untitled';
}

function ToastPreview({ alarm }: { alarm: AlarmDefinition }) {
  return (
    <div className="cfg-alarm-preview__section">
      <div className="cfg-alarm-preview__label">Popup notification</div>
      <div className="cfg-alarm-preview__toast">
        <AlarmToastCard level={alarm.level} code={alarm.code} title={alarmTitle(alarm)} disabled />
      </div>
      {!alarm.auto_popup && (
        <div className="cfg-alarm-preview__note">
          Auto Popup is off — this alarm will not appear automatically.
        </div>
      )}
    </div>
  );
}

function DetailPreview({ alarm }: { alarm: AlarmDefinition }) {
  const image = resolveAlarmImage(alarm.image);
  const resolutions = alarm.resolutions.map((r) => resolveAlarmString(r));

  return (
    <div className="cfg-alarm-preview__section">
      <div className="cfg-alarm-preview__label">Detail dialog</div>
      {/* The width sits on a wrapper, not on the card: the card composes the
          runtime's `.hmi-modal`, and a class of equal weight in config.css
          would win or lose on stylesheet order alone. */}
      <div className="cfg-alarm-preview__dialog">
        <AlarmDetailCard
          level={alarm.level}
          code={alarm.code}
          title={alarmTitle(alarm)}
          imageSrc={image ? assetUrl(image) : undefined}
          description={resolveAlarmString(alarm.description)}
          descriptionPlaceholder="No description."
          resolutions={resolutions}
          meta={<span>Triggered: —</span>}
          disabled
        />
      </div>
    </div>
  );
}

export default function AlarmPopupPreviewPanel({ config, selection }: Props) {
  // `resolveAlarmString` reads the dictionary imperatively, so the preview only
  // follows a language switch if something here subscribes to it.
  useTranslationStore((s) => s.activeLanguage);
  useTranslationStore((s) => s.translations);

  if (!selection || selection.type !== 'alarm') {
    return <div className="cfg-panel-empty">Select an alarm to preview its notifications.</div>;
  }

  const alarm = findAlarm(config, selection.id);
  if (!alarm) return null;

  return (
    <div className="cfg-alarm-preview">
      <ToastPreview alarm={alarm} />
      <DetailPreview alarm={alarm} />
    </div>
  );
}
