import ConfigWorkspace from '../ui/ConfigWorkspace';

export default function PreviewEmptyState({ message }: { message: string }) {
  return (
    <ConfigWorkspace flush className="editor-preview-panel">
      <div className="editor-tabbar editor-tabbar--empty" aria-hidden="true" />
      <div className="cfg-panel-empty">{message}</div>
    </ConfigWorkspace>
  );
}
