import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from './projectStore';
import { normalizeTranslationData, useTranslationStore } from './translationStore';

describe('translation identity and runtime resolution', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjectStore.setState({ dirty: false, _dirtySeq: 0, past: [], future: [] });
    useTranslationStore.setState({
      languages: [{ code: 'en-EN' }, { code: 'nl-NL' }],
      translations: {
        Start: { 'en-EN': 'Start', 'nl-NL': 'Starten' },
        Stop: { 'en-EN': 'Stop', 'nl-NL': '' },
      },
      revision: 'r0',
      activeLanguage: 'nl-NL',
      error: null,
      loaded: true,
      activeDictionary: 'Default',
      _draftsByDictionary: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects direct edits to the primary value without dirtying the project', () => {
    useTranslationStore.getState().updateCell('Start', 'en-EN', 'Begin');

    expect(useTranslationStore.getState().translations.Start['en-EN']).toBe('Start');
    expect(useTranslationStore.getState().error).toContain('immutable lookup key');
    expect(useProjectStore.getState().dirty).toBe(false);
  });

  it('keeps non-primary values editable', () => {
    useTranslationStore.getState().updateCell('Start', 'nl-NL', 'Beginnen');

    expect(useTranslationStore.getState().translations.Start['nl-NL']).toBe('Beginnen');
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('rejects edits for unknown languages', () => {
    useTranslationStore.getState().updateCell('Start', 'de-DE', 'Anfang');

    expect(useTranslationStore.getState().translations.Start['de-DE']).toBeUndefined();
    expect(useTranslationStore.getState().error).toContain('does not exist');
    expect(useProjectStore.getState().dirty).toBe(false);
  });

  it('resolves $loc through the active language and stable primary fallback', () => {
    expect(useTranslationStore.getState().resolve('Start')).toBe('Starten');
    expect(useTranslationStore.getState().resolve('Stop')).toBe('Stop');
    expect(useTranslationStore.getState().resolve('Missing')).toBe('Missing');
  });

  it('normalizes divergent or missing primary fields from the object key', () => {
    const normalized = normalizeTranslationData([{ code: 'en-EN' }, { code: 'nl-NL' }], {
      Start: { 'en-EN': 'Divergent', 'nl-NL': 'Starten' },
      Stop: { 'nl-NL': 'Stoppen' },
    });

    expect(normalized.translations.Start['en-EN']).toBeUndefined();
    expect(normalized.translations.Stop['en-EN']).toBeUndefined();
    expect(normalized.translations.Start['nl-NL']).toBe('Starten');

    useTranslationStore.getState().applyTranslationsUpdate({
      languages: normalized.languages,
      translations: {
        Start: { 'en-EN': 'Still divergent', 'nl-NL': 'Starten' },
      },
    });
    expect(useTranslationStore.getState().translations.Start['en-EN']).toBeUndefined();
    expect(useTranslationStore.getState().resolve('Start')).toBe('Starten');
  });

  it('rejects ingestion fields outside the dictionary contract', () => {
    expect(() =>
      normalizeTranslationData([{ code: 'en-EN' }], {
        Start: { 'nl-NL': 'Starten' },
      }),
    ).toThrow('unknown language');
  });

  it('targets language mutations at the active custom dictionary', async () => {
    useTranslationStore.setState({ activeDictionary: 'Custom' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            languages: [{ code: 'en-EN' }, { code: 'nl-NL' }, { code: 'fr-FR' }],
            rows: { Start: { 'en-EN': 'Start', 'nl-NL': 'Starten', 'fr-FR': '' } },
            revision: 'r1',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            languages: [{ code: 'en-EN' }, { code: 'fr-FR' }],
            rows: { Start: { 'en-EN': 'Start', 'fr-FR': '' } },
            revision: 'r2',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await useTranslationStore.getState().addLanguage('fr-FR');
    await useTranslationStore.getState().removeLanguage('nl-NL');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/config/translations/language?dict=Custom');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/config/translations/language/nl-NL?dict=Custom');
    expect(useTranslationStore.getState().languages).toEqual([
      { code: 'en-EN' },
      { code: 'fr-FR' },
    ]);
  });

  it('caches delayed mutation results without replacing a newly active dictionary', async () => {
    const cases = [
      {
        name: 'add row',
        invoke: () => useTranslationStore.getState().addTranslation('Stop'),
        rows: {
          Start: { 'en-EN': 'Start', 'nl-NL': 'Starten' },
          Stop: { 'en-EN': 'Stop', 'nl-NL': '' },
        },
        languages: [{ code: 'en-EN' }, { code: 'nl-NL' }],
      },
      {
        name: 'delete row',
        invoke: () => useTranslationStore.getState().deleteTranslation('Start'),
        rows: {},
        languages: [{ code: 'en-EN' }, { code: 'nl-NL' }],
      },
      {
        name: 'add language',
        invoke: () => useTranslationStore.getState().addLanguage('fr-FR'),
        rows: { Start: { 'en-EN': 'Start', 'nl-NL': 'Starten', 'fr-FR': '' } },
        languages: [{ code: 'en-EN' }, { code: 'nl-NL' }, { code: 'fr-FR' }],
      },
      {
        name: 'remove language',
        invoke: () => useTranslationStore.getState().removeLanguage('nl-NL'),
        rows: { Start: { 'en-EN': 'Start' } },
        languages: [{ code: 'en-EN' }],
      },
      {
        name: 'full save',
        invoke: () => useTranslationStore.getState().saveTranslations(),
        rows: { Start: { 'en-EN': 'Start', 'nl-NL': 'Starten' } },
        languages: [{ code: 'en-EN' }, { code: 'nl-NL' }],
      },
    ];

    for (const testCase of cases) {
      useTranslationStore.setState({
        activeDictionary: 'Custom',
        languages: [{ code: 'en-EN' }, { code: 'nl-NL' }],
        translations: { Start: { 'nl-NL': 'Starten' } },
        revision: 'custom-r0',
        loaded: true,
        _draftsByDictionary: {},
        error: null,
      });
      let resolveFetch!: (response: Response) => void;
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = testCase.invoke();
      expect(fetchMock, testCase.name).toHaveBeenCalledOnce();
      useTranslationStore.setState({
        activeDictionary: 'Other',
        languages: [{ code: 'de-DE' }],
        translations: { Andere: {} },
        revision: 'other-r0',
      });
      resolveFetch(
        new Response(
          JSON.stringify({
            languages: testCase.languages,
            rows: testCase.rows,
            revision: `custom-${testCase.name}`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await pending;

      const state = useTranslationStore.getState();
      expect(state.activeDictionary, testCase.name).toBe('Other');
      expect(state.languages, testCase.name).toEqual([{ code: 'de-DE' }]);
      expect(state.translations, testCase.name).toEqual({ Andere: {} });
      expect(state.revision, testCase.name).toBe('other-r0');
      expect(state._draftsByDictionary.Custom?.revision, testCase.name).toBe(
        `custom-${testCase.name}`,
      );
      vi.unstubAllGlobals();
    }
  });

  it('keeps the local draft and revision when a full save conflicts', async () => {
    useTranslationStore.setState({
      translations: { Start: { 'nl-NL': 'Local draft' } },
      revision: 'stale-r0',
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'translation dictionary changed' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const saved = await useTranslationStore.getState().saveTranslations();

    expect(saved).toBe(false);
    expect(useTranslationStore.getState().translations).toEqual({
      Start: { 'nl-NL': 'Local draft' },
    });
    expect(useTranslationStore.getState().revision).toBe('stale-r0');
    expect(useTranslationStore.getState().error).toContain('draft was kept');
    const request = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(request.revision).toBe('stale-r0');
  });

  it('preserves unrelated in-flight edits for every immediate structural mutation', async () => {
    const cases = [
      {
        name: 'add row',
        invoke: () => useTranslationStore.getState().addTranslation('Added'),
        serverRows: {
          Start: { 'nl-NL': 'Server old', 'de-DE': 'Server alt' },
          Stop: { 'nl-NL': 'Stoppen', 'de-DE': 'Stopp' },
          Added: { 'nl-NL': '', 'de-DE': '' },
        },
        serverLanguages: [{ code: 'en-EN' }, { code: 'nl-NL' }, { code: 'de-DE' }],
        edit: () =>
          useTranslationStore.setState((state) => ({
            translations: {
              ...state.translations,
              Start: { ...state.translations.Start, 'nl-NL': 'Edited in flight' },
            },
          })),
        assertPreserved: () =>
          expect(useTranslationStore.getState().translations.Start['nl-NL']).toBe(
            'Edited in flight',
          ),
      },
      {
        name: 'delete row',
        invoke: () => useTranslationStore.getState().deleteTranslation('Start'),
        serverRows: { Stop: { 'nl-NL': 'Server old', 'de-DE': 'Stopp' } },
        serverLanguages: [{ code: 'en-EN' }, { code: 'nl-NL' }, { code: 'de-DE' }],
        edit: () =>
          useTranslationStore.setState((state) => ({
            translations: {
              ...state.translations,
              Stop: { ...state.translations.Stop, 'nl-NL': 'Edited in flight' },
            },
          })),
        assertPreserved: () => {
          expect(useTranslationStore.getState().translations.Start).toBeUndefined();
          expect(useTranslationStore.getState().translations.Stop['nl-NL']).toBe(
            'Edited in flight',
          );
        },
      },
      {
        name: 'add language',
        invoke: () => useTranslationStore.getState().addLanguage('fr-FR'),
        serverRows: {
          Start: { 'nl-NL': 'Server old', 'de-DE': 'Server alt', 'fr-FR': '' },
          Stop: { 'nl-NL': 'Stoppen', 'de-DE': 'Stopp', 'fr-FR': '' },
        },
        serverLanguages: [
          { code: 'en-EN' },
          { code: 'nl-NL' },
          { code: 'de-DE' },
          { code: 'fr-FR' },
        ],
        edit: () =>
          useTranslationStore.setState((state) => ({
            translations: {
              ...state.translations,
              Start: { ...state.translations.Start, 'de-DE': 'Edited in flight' },
            },
          })),
        assertPreserved: () =>
          expect(useTranslationStore.getState().translations.Start['de-DE']).toBe(
            'Edited in flight',
          ),
      },
      {
        name: 'remove language',
        invoke: () => useTranslationStore.getState().removeLanguage('nl-NL'),
        serverRows: {
          Start: { 'de-DE': 'Server alt' },
          Stop: { 'de-DE': 'Stopp' },
        },
        serverLanguages: [{ code: 'en-EN' }, { code: 'de-DE' }],
        edit: () =>
          useTranslationStore.setState((state) => ({
            translations: {
              ...state.translations,
              Start: { ...state.translations.Start, 'de-DE': 'Edited in flight' },
            },
          })),
        assertPreserved: () => {
          expect(useTranslationStore.getState().translations.Start['nl-NL']).toBeUndefined();
          expect(useTranslationStore.getState().translations.Start['de-DE']).toBe(
            'Edited in flight',
          );
        },
      },
    ];

    for (const testCase of cases) {
      useProjectStore.setState({ past: [], future: [] });
      useTranslationStore.setState({
        activeDictionary: 'Custom',
        languages: [{ code: 'en-EN' }, { code: 'nl-NL' }, { code: 'de-DE' }],
        translations: {
          Start: { 'nl-NL': 'Local', 'de-DE': 'Lokal' },
          Stop: { 'nl-NL': 'Stoppen', 'de-DE': 'Stopp' },
        },
        revision: 'r0',
        loaded: true,
        _draftsByDictionary: {},
      });
      let resolveFetch!: (response: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        ),
      );

      const pending = testCase.invoke();
      testCase.edit();
      resolveFetch(
        new Response(
          JSON.stringify({
            languages: testCase.serverLanguages,
            rows: testCase.serverRows,
            revision: `revision-${testCase.name}`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await pending;

      testCase.assertPreserved();
      expect(useTranslationStore.getState().revision, testCase.name).toBe(
        `revision-${testCase.name}`,
      );
      vi.unstubAllGlobals();
    }
  });

  it.each(['add', 'delete'] as const)(
    'keeps the latest revision through %s-language undo, save, redo, and save',
    async (operation) => {
      const startsWithSecondary = operation === 'delete';
      useTranslationStore.setState({
        languages: startsWithSecondary
          ? [{ code: 'en-EN' }, { code: 'nl-NL' }]
          : [{ code: 'en-EN' }],
        translations: { Start: startsWithSecondary ? { 'nl-NL': 'Starten' } : {} },
        revision: 'r0',
        loaded: true,
        _draftsByDictionary: {},
      });
      const afterMutationLanguages = startsWithSecondary
        ? [{ code: 'en-EN' }]
        : [{ code: 'en-EN' }, { code: 'nl-NL' }];
      const beforeMutationLanguages = useTranslationStore.getState().languages;
      const responses = [
        {
          languages: afterMutationLanguages,
          rows: { Start: startsWithSecondary ? {} : { 'nl-NL': '' } },
          revision: 'r1',
        },
        {
          languages: beforeMutationLanguages,
          rows: { Start: startsWithSecondary ? { 'nl-NL': 'Starten' } : {} },
          revision: 'r2',
        },
        {
          languages: afterMutationLanguages,
          rows: { Start: startsWithSecondary ? {} : { 'nl-NL': '' } },
          revision: 'r3',
        },
      ];
      const fetchMock = vi.fn();
      for (const response of responses) {
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      vi.stubGlobal('fetch', fetchMock);

      if (operation === 'add') await useTranslationStore.getState().addLanguage('nl-NL');
      else await useTranslationStore.getState().removeLanguage('nl-NL');
      expect(useTranslationStore.getState().revision).toBe('r1');

      useProjectStore.getState().undo();
      expect(useTranslationStore.getState().languages).toEqual(beforeMutationLanguages);
      expect(useTranslationStore.getState().revision).toBe('r1');
      expect(await useTranslationStore.getState().saveTranslations()).toBe(true);

      useProjectStore.getState().redo();
      expect(useTranslationStore.getState().languages).toEqual(afterMutationLanguages);
      expect(useTranslationStore.getState().revision).toBe('r2');
      expect(await useTranslationStore.getState().saveTranslations()).toBe(true);

      const firstSave = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      const secondSave = JSON.parse(fetchMock.mock.calls[2][1].body as string);
      expect(firstSave.revision).toBe('r1');
      expect(secondSave.revision).toBe('r2');
    },
  );

  it('clears generic undo history after immediate row add and delete', async () => {
    useProjectStore.getState().pushSnapshot();
    expect(useProjectStore.getState().past).toHaveLength(1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            languages: [{ code: 'en-EN' }, { code: 'nl-NL' }],
            rows: {
              Start: { 'nl-NL': 'Starten' },
              Stop: { 'nl-NL': '' },
            },
            revision: 'r1',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            languages: [{ code: 'en-EN' }, { code: 'nl-NL' }],
            rows: { Start: { 'nl-NL': 'Starten' } },
            revision: 'r2',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await useTranslationStore.getState().addTranslation('Stop');
    expect(useProjectStore.getState().past).toHaveLength(0);
    useProjectStore.getState().pushSnapshot();
    await useTranslationStore.getState().deleteTranslation('Stop');
    expect(useProjectStore.getState().past).toHaveLength(0);
    expect(useProjectStore.getState().future).toHaveLength(0);
  });
});
