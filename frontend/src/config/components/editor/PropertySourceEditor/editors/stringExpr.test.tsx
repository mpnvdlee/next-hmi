import { useState, type ComponentType } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { StringExprEditor } from './stringExpr';
import { HttpEditor } from './http';
import { loadVariableWriteDescriptor } from '@config/utils/variableType';

vi.mock('@config/utils/variableType', () => ({
  loadVariableWriteDescriptor: vi.fn(async () => undefined),
}));

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

  it('keeps Translate on while the template is retyped', () => {
    const onChange = vi.fn();
    render(
      <Harness
        Editor={StringExprEditor}
        initial={{ $stringExpr: { template: '{1}', wildcards: { 1: '' } } }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /Translate the template/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      $stringExpr: { template: '{1}', wildcards: { 1: '' }, translate: true },
    });

    fireEvent.change(screen.getByPlaceholderText('{1} - {ToLower(2)}, {3}'), {
      target: { value: 'Band {1}' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      $stringExpr: { template: 'Band {1}', wildcards: { 1: '' }, translate: true },
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

describe('a placeholder bound to a whole array', () => {
  it('asks for the element, as a placeholder prints one value', async () => {
    vi.mocked(loadVariableWriteDescriptor).mockResolvedValueOnce({
      dataType: 'Double',
      isArray: true,
      arrayLength: 5,
    });
    render(
      <Harness
        Editor={StringExprEditor}
        initial={{
          $stringExpr: {
            template: '{1}',
            wildcards: { 1: { $var: { path: 'Ui:Batches/Dones' } } },
          },
        }}
        onChange={vi.fn()}
      />,
    );
    expect(await screen.findByText('Element of the array, 0 to 4')).toBeInTheDocument();
  });
});
