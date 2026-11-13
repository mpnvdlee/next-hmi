import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useRecipeStore } from '../store/recipeStore';
import { useVariableStore } from '../store/variableStore';
import { evaluatePropertyValue } from '../utils/propertySourceEval';
import { useReactiveEval } from './useReactiveEval';

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

// A shell region evaluates outside any widget, so it follows what its values
// read itself — a recipe's changed state reads its parameters' live values,
// which the `$recipe` source does not name.
it("re-evaluates a recipe's changed state when a parameter's live value moves", () => {
  useRecipeStore.getState().setSnapshot(
    {
      version: 1,
      datasetTypes: [
        {
          id: 'coffee',
          name: 'Coffee',
          parameters: [
            {
              id: 'dose',
              label: 'Dose',
              binding: { $var: { path: 'PLC:Dose' } },
              dataType: 'integer',
            },
          ],
          datasets: [
            {
              id: 'espresso',
              name: 'Espresso',
              description: '',
              values: { dose: 18 },
              updatedAt: '',
              updatedBy: '',
              loadedAt: '',
            },
          ],
        },
      ],
    },
    { coffee: { datasetId: 'espresso', loadedAt: '' } },
    null,
  );
  useVariableStore.setState({ values: { 'PLC:Dose': 18 } });
  const value = { $recipe: { type: 'coffee', field: 'parametersChanged' } };

  const { result } = renderHook(() => evaluatePropertyValue(value, useReactiveEval(value)), {
    wrapper,
  });
  expect(result.current).toBe(false);

  act(() => useVariableStore.getState().applyBatch({ 'PLC:Dose': 20 }));
  expect(result.current).toBe(true);
});
