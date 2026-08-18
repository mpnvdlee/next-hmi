import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from '@shared/utils/api';
import {
  summarizeFieldDiagnostics,
  useFieldDiagnostic,
  usePanelDiagnostics,
  type Diagnostic,
  type DiagnosticsArtifact,
} from './usePanelDiagnostics';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

const invalidBinding: Diagnostic = {
  artifactId: 'page-1',
  artifactKind: 'page',
  widgetId: 'condition-1',
  propKey: 'title',
  fieldPath: ['title', '$if', 'condition', '$compare', 'left'],
  code: 'var-unknown',
  severity: 'error',
  message: "unknown variable 'MyPLC:Motor/test'",
  breadcrumb: 'If Condition › title',
  nested: true,
};

describe('summarizeFieldDiagnostics', () => {
  it('marks expression ancestors with a dot and the exact binding field with the full error', () => {
    expect(summarizeFieldDiagnostics([invalidBinding], ['title'])).toMatchObject({
      level: 'error',
      nested: true,
    });
    expect(
      summarizeFieldDiagnostics([invalidBinding], ['title', '$if', 'condition']),
    ).toMatchObject({
      level: 'error',
      nested: true,
    });
    expect(
      summarizeFieldDiagnostics(
        [invalidBinding],
        ['title', '$if', 'condition', '$compare', 'left'],
      ),
    ).toEqual({
      level: 'error',
      message: "unknown variable 'MyPLC:Motor/test'",
      nested: false,
    });
  });

  it('does not leak a sibling diagnostic into another operand', () => {
    expect(
      summarizeFieldDiagnostics(
        [invalidBinding],
        ['title', '$if', 'condition', '$compare', 'right'],
      ),
    ).toBeUndefined();
  });

  it('attaches diagnostics to decoded property keys containing slash and tilde', () => {
    const escapedKeyDiagnostic: Diagnostic = {
      ...invalidBinding,
      sourcePath: '/children/0/properties/label~1~0primary/nested~1~0slot/$var',
      propKey: 'label/~primary',
      fieldPath: ['label/~primary', 'nested/~slot', '$var'],
    };

    expect(
      summarizeFieldDiagnostics([escapedKeyDiagnostic], ['label/~primary', 'nested/~slot']),
    ).toMatchObject({ level: 'error', nested: true });
    expect(summarizeFieldDiagnostics([escapedKeyDiagnostic], ['label~1~0primary'])).toBeUndefined();
  });
});

describe('usePanelDiagnostics', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(apiJson).mockReset();
  });

  it('ignores an in-flight response after the artifact is cleared', async () => {
    vi.useFakeTimers();
    let resolveRequest!: (value: { diagnostics: Diagnostic[] }) => void;
    vi.mocked(apiJson).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const artifact: DiagnosticsArtifact = { kind: 'page', id: 'p1', draft: {} };
    const initialProps: { currentArtifact: DiagnosticsArtifact | null } = {
      currentArtifact: artifact,
    };

    const { result, rerender } = renderHook(
      ({ currentArtifact }: { currentArtifact: DiagnosticsArtifact | null }) => {
        usePanelDiagnostics(currentArtifact);
        return useFieldDiagnostic('condition-1', ['title']);
      },
      { initialProps },
    );

    act(() => vi.runAllTimers());
    rerender({ currentArtifact: null });
    await act(async () => resolveRequest({ diagnostics: [invalidBinding] }));

    expect(result.current).toBeUndefined();
  });
});
