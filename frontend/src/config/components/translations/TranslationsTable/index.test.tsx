import { render, screen, within } from '@testing-library/react';
import TranslationsTable from './index';

describe('TranslationsTable search highlighting', () => {
  it('highlights only the matching text behind editable translation inputs', () => {
    render(
      <TranslationsTable
        languages={[{ code: 'en' }, { code: 'nl' }]}
        filtered={['motor_on']}
        translations={{ motor_on: { en: 'Motor on', nl: 'Motor aan' } }}
        newRow={{}}
        addError={null}
        filter="mot"
        onUpdateCell={vi.fn()}
        onDeleteKey={vi.fn()}
        onSetNewRowValue={vi.fn()}
        onSubmitNewRow={vi.fn()}
        onRemoveLanguage={vi.fn()}
        onFilterChange={vi.fn()}
      />,
    );

    const editableInput = screen.getByDisplayValue('Motor aan');
    const cell = editableInput.closest('td');
    expect(cell).not.toBeNull();
    expect(within(cell!).getByText('Mot')).toHaveClass('cfg-search-match');
    expect(editableInput).toHaveClass('cfg-trans-highlight-input__input');
    expect(editableInput).not.toHaveClass('cfg-prop-input cfg-prop-input--compact--search-match');
    const primaryValue = screen.getByLabelText('Translation key: motor_on');
    expect(primaryValue).toHaveTextContent('motor_on');
    expect(screen.queryByDisplayValue('Motor on')).not.toBeInTheDocument();
  });
});
