import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import NewProjectTemplateModal from './NewProjectTemplateModal';

describe('NewProjectTemplateModal', () => {
  it('offers both templates', () => {
    render(<NewProjectTemplateModal onCancel={() => {}} onChoose={() => {}} />);
    expect(screen.getByRole('button', { name: /empty project/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /example/i })).toBeInTheDocument();
  });

  it('reports the chosen template', () => {
    const onChoose = vi.fn();
    render(<NewProjectTemplateModal onCancel={() => {}} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole('button', { name: /example/i }));
    expect(onChoose).toHaveBeenCalledWith('example');
  });

  it('reports the empty template', () => {
    const onChoose = vi.fn();
    render(<NewProjectTemplateModal onCancel={() => {}} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole('button', { name: /empty project/i }));
    expect(onChoose).toHaveBeenCalledWith('empty');
  });

  it('cancels', () => {
    const onCancel = vi.fn();
    render(<NewProjectTemplateModal onCancel={onCancel} onChoose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
