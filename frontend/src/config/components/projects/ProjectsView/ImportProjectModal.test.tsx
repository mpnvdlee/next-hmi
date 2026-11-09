import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  ProjectCodeUnconfirmedError,
  ProjectIdCaseConflictError,
  type ProjectCode,
  useProjectsStore,
} from '@config/store/projectsStore';
import ImportProjectModal from './ImportProjectModal';

const INITIAL = useProjectsStore.getState();
const ZIP = new File(['zip'], 'plant.nexthmi.zip', { type: 'application/zip' });
const TRUST = 'I trust the source of this project and want to run its code';
const NONE: ProjectCode = { customWidgets: [], externalLibraries: [], importOverrides: [] };

function unconfirmed(code: Partial<ProjectCode>) {
  return new ProjectCodeUnconfirmedError('409', { ...NONE, ...code });
}

const CASE_CONFLICT =
  "The project 'line3' already exists. Project ids ignore upper and lower case, because on " +
  'Windows and macOS they share one folder.';

function caseConflict() {
  return new ProjectIdCaseConflictError(CASE_CONFLICT, 'LINE3-2');
}

const importProject = vi.fn();
const onImported = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  importProject.mockReset();
  onImported.mockReset();
  useProjectsStore.setState({
    ...INITIAL,
    importProject,
    validatePath: vi.fn().mockResolvedValue({ ok: true, exists: false }),
  });
  render(
    <ImportProjectModal defaultRoot="/projects" onCancel={() => {}} onImported={onImported} />,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

/** Picks the zip and lets the debounced destination check settle. */
async function chooseZip(file: File) {
  fireEvent.change(screen.getByLabelText('Zip file'), { target: { files: [file] } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

async function clickImport() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
  });
}

describe('ImportProjectModal', () => {
  it('imports a project without code in one step', async () => {
    importProject.mockResolvedValue({});
    await chooseZip(ZIP);

    await clickImport();

    expect(importProject).toHaveBeenCalledWith(ZIP, '/projects/plant', false, undefined);
    expect(onImported).toHaveBeenCalled();
  });

  it('asks for trust before importing code, then resubmits with it', async () => {
    importProject
      .mockRejectedValueOnce(
        unconfirmed({
          customWidgets: ['Gauges/Dial', 'Leak'],
          externalLibraries: ['three'],
          importOverrides: ['lodash'],
        }),
      )
      .mockResolvedValueOnce({});
    await chooseZip(ZIP);

    await clickImport();

    expect(onImported).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'This project contains code: 2 custom widgets, 1 external library, 1 import-map ' +
          'override. It runs in the browser of everyone who opens the project, with the same ' +
          'access as this dashboard. Only import projects from a source you trust.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Gauges/Dial')).toBeInTheDocument();
    expect(screen.getByText('Leak')).toBeInTheDocument();
    expect(screen.getByText('external-libraries/three')).toBeInTheDocument();
    expect(screen.getByText('external-modules.json: lodash')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: TRUST }));
    await clickImport();

    expect(importProject).toHaveBeenLastCalledWith(ZIP, '/projects/plant', true, undefined);
    expect(onImported).toHaveBeenCalled();
  });

  it('names the case clash and imports under the suggested id in one click', async () => {
    importProject.mockRejectedValueOnce(caseConflict()).mockResolvedValueOnce({});
    await chooseZip(ZIP);

    await clickImport();

    expect(screen.getByText(CASE_CONFLICT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(onImported).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use LINE3-2 instead' }));
    });

    expect(importProject).toHaveBeenLastCalledWith(ZIP, '/projects/plant', false, 'LINE3-2');
    expect(onImported).toHaveBeenCalled();
  });

  it('keeps the suggested id when the import then asks for trust', async () => {
    importProject
      .mockRejectedValueOnce(caseConflict())
      .mockRejectedValueOnce(unconfirmed({ customWidgets: ['Leak'] }))
      .mockResolvedValueOnce({});
    await chooseZip(ZIP);
    await clickImport();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use LINE3-2 instead' }));
    });
    expect(screen.queryByText(CASE_CONFLICT)).not.toBeInTheDocument();
    expect(screen.getByText('Imports under the project id LINE3-2.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: TRUST }));
    await clickImport();

    expect(importProject).toHaveBeenLastCalledWith(ZIP, '/projects/plant', true, 'LINE3-2');
    expect(onImported).toHaveBeenCalled();
  });

  it('asks again for a different zip', async () => {
    importProject.mockRejectedValueOnce(unconfirmed({ customWidgets: ['Leak'] }));
    await chooseZip(ZIP);
    await clickImport();
    expect(screen.getByText(/^This project contains code: 1 custom widget\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: TRUST }));

    await chooseZip(new File(['zip'], 'other.zip'));

    expect(screen.queryByText(/contains code/)).not.toBeInTheDocument();
    importProject.mockResolvedValueOnce({});
    await clickImport();
    expect(importProject).toHaveBeenLastCalledWith(
      expect.any(File),
      '/projects/other',
      false,
      undefined,
    );
  });
});
