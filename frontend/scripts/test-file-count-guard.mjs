// Fail a full test run that quietly ran fewer spec files than the config matches.
//
// Twice in fourteen full runs (2026-09-17) vitest printed a clean
// `Test Files 248 passed (248)` against a tree holding 250 spec files: two
// files never reported back, and the only trace was a denominator nobody
// reads. A shrinking denominator is indistinguishable from success, which
// makes it worse than a red — a red at least asks to be looked at.
//
// The root cause is not known. Four hypotheses were tested and falsified
// (machine load, a preceding build, a JSON-reporter artifact, the dev server
// writing shared files), and it has not reproduced since. So this fixes
// nothing: it turns the next occurrence into a red run that names the missing
// files, which is the evidence the investigation lacked.
//
// The expected set comes from `globTestSpecifications()` — vitest's own glob,
// so it tracks `include`/`exclude` in vitest.config.ts with no second copy of
// those rules to drift.

// Flags that consume the following argv token, so their value is not mistaken
// for a file filter. Only forms used in practice need listing; `--flag=value`
// needs no entry.
const VALUE_FLAGS = new Set([
  '--reporter',
  '--outputFile',
  '--config',
  '--project',
  '--pool',
  '--environment',
  '--shard',
  '--testNamePattern',
  '-t',
  '--exclude',
  '--include',
  '--retry',
  '--bail',
  '--maxWorkers',
  '--minWorkers',
  '--maxConcurrency',
  '--mode',
]);

// Positional words that select a mode rather than filter files.
const MODE_WORDS = new Set(['run', 'watch', 'related', 'bench', 'list', 'init']);

/** True when the command line names specific test files, making a short run correct. */
function hasFileFilters(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    if (!MODE_WORDS.has(arg)) return true;
  }
  return false;
}

export default class TestFileCountGuard {
  onInit(ctx) {
    this.ctx = ctx;
  }

  async onTestRunEnd(testModules, _unhandledErrors, reason) {
    // A run the operator stopped is short by design.
    if (reason === 'interrupted') return;
    if (hasFileFilters(process.argv.slice(2))) return;
    // A shard is one slice of the suite; running fewer files is the point.
    if (this.ctx.config?.shard) return;
    // A watch rerun reports only the specs it re-ran, so every other spec
    // looks "missing". The count only means anything for a whole-suite run.
    if (this.ctx.config?.watch) return;

    let expected;
    try {
      expected = await this.ctx.globTestSpecifications();
    } catch (error) {
      // Never convert a healthy run into a red one because the guard itself broke.
      console.error(`Test file guard: could not glob specifications (${error}); skipping check.`);
      return;
    }

    const ran = new Set(testModules.map((module) => module.moduleId));
    const missing = expected
      .map((specification) => specification.moduleId)
      .filter((moduleId) => !ran.has(moduleId))
      .sort();

    if (missing.length === 0) return;

    const root = this.ctx.config?.root ?? process.cwd();
    const relative = (absolute) =>
      absolute.startsWith(root) ? absolute.slice(root.length + 1) : absolute;

    console.error(
      [
        '',
        `Test file guard: ${missing.length} spec file(s) matched the config but never reported a result.`,
        `  ran ${ran.size} of ${ran.size + missing.length}`,
        '',
        ...missing.map((moduleId) => `  missing: ${relative(moduleId)}`),
        '',
        'The summary above can still read as green while skipping these.',
        'Run them directly to see whether they pass in isolation.',
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
  }
}
