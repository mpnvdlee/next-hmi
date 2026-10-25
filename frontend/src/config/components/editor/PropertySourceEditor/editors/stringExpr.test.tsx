import { useState, type ComponentType } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { StringExprEditor } from './stringExpr';
import { HttpEditor } from './http';

type Editor = ComponentType<{ value: unknown; onChange: (v: unknown) => void }>;

function Harness({
  Editor,
  initial,
  onChange,
}: {
  Editor: Editor;
  initial: unknown;
  onChange: (v: unknown) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Editor
      value={value}
      onChange={(v) => {
        onChange(v);
        setValue(v);
      }}
    />
  );
}

const unbound = { $var: { path: '' } };

describe('placeholder rows the editor adds', () => {
  it('start a typed String Expr placeholder unbound and keep a cleared Static', () => {
    const onChange = vi.fn();
    render(
      <Harness
        Editor={StringExprEditor}
        initial={{ $stringExpr: { template: '{1}', wildcards: { 1: '' } } }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('{1} - {ToLower(2)}, {3}'), {
      target: { value: '{1} {2}' },
    });

    expect(onChange).toHaveBeenLastCalledWith({
      $stringExpr: { template: '{1} {2}', wildcards: { 1: '', 2: unbound } },
    });
  });

  it('start a typed HTTP Request placeholder unbound', () => {
    const onChange = vi.fn();
    render(<Harness Editor={HttpEditor} initial={{ $http: { url: '' } }} onChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/devices/{1}/status'), {
      target: { value: 'https://plc/{1}' },
    });

    expect(onChange).toHaveBeenLastCalledWith({
      $http: expect.objectContaining({ url: 'https://plc/{1}', wildcards: { 1: unbound } }),
    });
  });
});
