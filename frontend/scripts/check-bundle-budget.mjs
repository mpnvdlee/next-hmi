#!/usr/bin/env node
// Backlog item 22: route-aware bundle-size budget, enforced in CI.
//
// Reads dist/.vite/manifest.json (requires build.manifest: true), dist/_app/*
// and dist/stdlib-js/* to check three things:
//
// 1. A hard per-chunk cap (any chunk <=250 kB raw / <=75 kB gzip), with one
//    named exception: the chart vendor chunk (recharts + d3-*), which is the
//    documented "chart increment" and gets its own <=200 kB gzip budget.
// 2. A cap over the built-in (stdlib) widget modules. These are compiled by
//    esbuild into dist/stdlib-js/<Category>/<Widget>/{index.js,style.css,fonts/},
//    outside Vite's graph entirely, so check 1 never sees them: every byte of
//    a stdlib widget would otherwise be unbudgeted. Each widget's own published
//    files are capped, and so is the whole served tree.
// 3. Named route budgets (manager/basic HMI/editor/chart-heavy HMI), computed
//    by walking each route's *static* import closure in the manifest
//    (dynamicImports are lazy-loaded-on-demand and correctly excluded) —
//    unioned across all of a route's entry points where more than one applies.
//    `chart-heavy-hmi` isn't its own Vite entry point, and TrendChart is a
//    stdlib widget with no manifest entry to union in, so that route is built
//    as basic-HMI's closure plus the two things a chart page actually adds:
//    the recharts chunk `ensureRecharts()` dynamically imports, and
//    TrendChart's own stdlib module from check 2's tree.
//
// All three checks are CI-enforced. `vendor-icons` (all @phosphor-icons/react
// icons used by the HMI runtime, ~94 kB gzip) used to be a static import of
// every route via nextHmiSdk.ts's custom-widget SDK exposure and the Icon/Button/
// MenuToggleButton/NavigationMenu built-ins; phosphorIcons.tsx now lazy-loads
// each icon's component from a separate phosphorIconComponents.tsx chunk, so
// only routes that actually render a builtin icon fetch it. Editor authoring
// surfaces (WidgetIcon, IconSourcePicker) still import that chunk directly
// for flicker-free synchronous rendering — editor already reaches
// vendor-icons eagerly via its own UI-chrome icon imports regardless.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
const appDir = path.join(distDir, '_app');
const stdlibDir = path.join(distDir, 'stdlib-js');
const manifestPath = path.join(distDir, '.vite', 'manifest.json');

const CHART_CHUNK_PATTERN = /^vendor-charts-/;
const ICON_CHUNK_PATTERN = /^vendor-icons-/;
const ANY_CHUNK_RAW_BUDGET = 250 * 1024;
const ANY_CHUNK_GZIP_BUDGET = 75 * 1024;
const CHART_CHUNK_GZIP_BUDGET = 200 * 1024;
// `vendor-icons` scales with the size of the built-in icon allowlist, not with
// application code, so it gets its own budget like the chart chunk: one
// @phosphor-icons module carries all six weights of one glyph, ~0.6 kB gzip,
// and the allowlist is a product surface that grows on purpose (59 icons /
// 52.8 kB gzip → 130 icons / 93.7 kB gzip). Raise it deliberately when the
// allowlist expands. The cheaper alternative to a raise is lazifying the two
// editor surfaces that render the whole set synchronously (WidgetIcon,
// IconSourcePicker) so the chunk leaves the editor route's static closure.
const ICON_CHUNK_RAW_BUDGET = 450 * 1024;
const ICON_CHUNK_GZIP_BUDGET = 100 * 1024;

// Two caps that guard different things. The per-widget cap (every file the
// widget publishes — index.js, style.css and any fonts/ it ships) is the
// page-weight guard: a page fetches only the stdlib modules for the widgets it
// places, so one widget's size is what an operator actually pays for. Hold it tight — a widget that breaches it has grown a dependency or
// swallowed a responsibility, and that is worth a look regardless of the total.
// The tree cap guards the total product surface instead: it is the size of every
// built-in put together, manifest.json included, and it grows with each widget
// promoted into the stdlib. Raise it deliberately when the set expands; never
// raise the per-widget cap to make room for the tree.
const STDLIB_WIDGET_RAW_BUDGET = 32 * 1024;
const STDLIB_WIDGET_GZIP_BUDGET = 10 * 1024;
const STDLIB_TREE_GZIP_BUDGET = 96 * 1024;

const ROUTE_BUDGETS_GZIP = {
  manager: 150 * 1024,
  'basic-hmi': 150 * 1024,
  // The editor's shared chunk carries the tree drag-and-drop, clipboard and
  // multi-selection surfaces eagerly. Raised from 250 kB once that growth was
  // accepted as intrinsic; the recoverable path is lazifying the
  // gesture-triggered editors, not a further raise. Raised again from 275 kB
  // when the icon allowlist grew to 130 icons — the editor renders the whole
  // set synchronously, so vendor-icons' +41 kB gzip lands in this closure; the
  // recoverable path there is lazifying WidgetIcon/IconSourcePicker. Raised
  // again from 320 kB for React 19's larger vendor-react chunk (~+14 kB
  // gzip) — no code-side fix available for framework-runtime growth.
  editor: 325 * 1024,
  'chart-heavy-hmi': 350 * 1024,
};
const ROUTE_ENTRY_POINTS = {
  manager: ['src/manager/ManagerApp.tsx'],
  'basic-hmi': ['src/hmi/pages/HmiView.tsx'],
  editor: ['src/config/pages/EditorView.tsx'],
  'chart-heavy-hmi': ['src/hmi/pages/HmiView.tsx'],
};
// Routes that additionally pull a lazily-imported chunk matched by this pattern.
const ROUTE_EXTRA_CHUNKS = {
  'chart-heavy-hmi': CHART_CHUNK_PATTERN,
};
// Routes that additionally load these built-in widget modules from stdlib-js/.
// Keyed by the widget's directory under dist/stdlib-js/.
const ROUTE_EXTRA_STDLIB_WIDGETS = {
  'chart-heavy-hmi': ['Content/TrendChart'],
};

function sizesOf(file) {
  const raw = readFileSync(file);
  return { raw: raw.length, gzip: gzipSync(raw).length };
}

function fmtKb(bytes) {
  return `${(bytes / 1024).toFixed(1)}kB`;
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
} catch {
  console.error(
    `[bundle-budget] Could not read ${manifestPath} — run \`npm run build\` first (requires build.manifest: true in vite.config.ts).`,
  );
  process.exit(1);
}

// ── 1. Per-chunk cap ──────────────────────────────────────────────────────
const failures = [];
const jsFiles = readdirSync(appDir).filter((f) => f.endsWith('.js'));
for (const f of jsFiles) {
  const { raw, gzip } = sizesOf(path.join(appDir, f));
  if (CHART_CHUNK_PATTERN.test(f)) {
    if (gzip > CHART_CHUNK_GZIP_BUDGET) {
      failures.push(
        `${f}: chart chunk ${fmtKb(gzip)} gzip exceeds the ${fmtKb(CHART_CHUNK_GZIP_BUDGET)} chart-increment budget`,
      );
    }
    continue;
  }
  if (ICON_CHUNK_PATTERN.test(f)) {
    if (raw > ICON_CHUNK_RAW_BUDGET || gzip > ICON_CHUNK_GZIP_BUDGET) {
      failures.push(
        `${f}: icon chunk ${fmtKb(raw)} raw / ${fmtKb(gzip)} gzip exceeds the ${fmtKb(ICON_CHUNK_RAW_BUDGET)} raw / ${fmtKb(ICON_CHUNK_GZIP_BUDGET)} gzip icon-allowlist budget`,
      );
    }
    continue;
  }
  if (raw > ANY_CHUNK_RAW_BUDGET || gzip > ANY_CHUNK_GZIP_BUDGET) {
    failures.push(
      `${f}: ${fmtKb(raw)} raw / ${fmtKb(gzip)} gzip exceeds the ${fmtKb(ANY_CHUNK_RAW_BUDGET)} raw / ${fmtKb(ANY_CHUNK_GZIP_BUDGET)} gzip per-chunk budget`,
    );
  }
}

// ── 2. Built-in (stdlib) widget modules — esbuild output, not in the manifest ─
// Missing entirely is a build defect, not an empty budget: public/stdlib-js is
// gitignored, so a dist/ assembled without the compile step ships an app whose
// every built-in widget 404s. Fail loudly rather than report 0 kB.
if (!existsSync(stdlibDir)) {
  console.error(
    `[bundle-budget] ${stdlibDir} is missing — the built-in widget modules were never compiled into this dist. Run \`npm run build\` (not \`vite build\` alone).`,
  );
  process.exit(1);
}

function stdlibWidgetDirs(dir = stdlibDir, prefix = '') {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const child = path.join(dir, entry.name);
    // A widget directory is the one holding index.js; anything above it is a
    // category (Content/, Layout/, Navigation/).
    if (existsSync(path.join(child, 'index.js'))) found.push(rel);
    else found.push(...stdlibWidgetDirs(child, rel));
  }
  return found;
}

// Walks subdirectories rather than only the widget's top level: publish copies a
// widget's `fonts/` across whole, and those bytes are page weight like any other
// — a page that places the widget fetches the faces its stylesheet names. Sizing
// the directory entry itself threw EISDIR and took the whole check down.
function stdlibWidgetSizes(widget) {
  const totals = { raw: 0, gzip: 0 };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      const { raw, gzip } = sizesOf(child);
      totals.raw += raw;
      totals.gzip += gzip;
    }
  };
  walk(path.join(stdlibDir, widget));
  return totals;
}

const stdlibWidgets = stdlibWidgetDirs();
let stdlibTreeGzip = 0;
for (const name of readdirSync(stdlibDir).filter((f) => f.endsWith('.json'))) {
  stdlibTreeGzip += sizesOf(path.join(stdlibDir, name)).gzip;
}
for (const widget of stdlibWidgets) {
  const { raw, gzip } = stdlibWidgetSizes(widget);
  stdlibTreeGzip += gzip;
  if (raw > STDLIB_WIDGET_RAW_BUDGET || gzip > STDLIB_WIDGET_GZIP_BUDGET) {
    failures.push(
      `stdlib-js/${widget}: ${fmtKb(raw)} raw / ${fmtKb(gzip)} gzip exceeds the ${fmtKb(STDLIB_WIDGET_RAW_BUDGET)} raw / ${fmtKb(STDLIB_WIDGET_GZIP_BUDGET)} gzip per-widget budget`,
    );
  }
}
console.log(
  `\nBuilt-in widget modules (dist/stdlib-js): ${stdlibWidgets.length} widget(s), ${fmtKb(stdlibTreeGzip)} gzip (budget ${fmtKb(STDLIB_TREE_GZIP_BUDGET)})`,
);
if (stdlibTreeGzip > STDLIB_TREE_GZIP_BUDGET) {
  failures.push(
    `stdlib-js: ${fmtKb(stdlibTreeGzip)} gzip exceeds the ${fmtKb(STDLIB_TREE_GZIP_BUDGET)} stdlib-tree budget`,
  );
}

// ── 3. Named route budgets (static-import closure) — enforced ─────────────
function closureFiles(entryKey, seen = new Set()) {
  const entry = manifest[entryKey];
  if (!entry || seen.has(entryKey)) return seen;
  seen.add(entryKey);
  for (const dep of entry.imports ?? []) closureFiles(dep, seen);
  return seen;
}

function routeGzipTotal(entryKeys) {
  const files = new Set();
  for (const entryKey of entryKeys) {
    for (const f of closureFiles(entryKey)) files.add(f);
  }
  files.add('index.html'); // every route loads through the main entry
  let total = 0;
  for (const key of files) {
    const file = manifest[key]?.file;
    if (!file || !file.endsWith('.js')) continue;
    total += sizesOf(path.join(distDir, file)).gzip;
  }
  return total;
}

console.log('\nRoute static-import-closure gzip totals:');
for (const [route, entryKeys] of Object.entries(ROUTE_ENTRY_POINTS)) {
  const missing = entryKeys.filter((k) => !manifest[k]);
  if (missing.length > 0) {
    console.log(`  ${route}: entry(ies) ${missing.join(', ')} not found in manifest, skipped`);
    continue;
  }
  let total = routeGzipTotal(entryKeys);
  const extra = ROUTE_EXTRA_CHUNKS[route];
  if (extra) {
    for (const f of jsFiles.filter((f) => extra.test(f))) {
      total += sizesOf(path.join(appDir, f)).gzip;
    }
  }
  for (const widget of ROUTE_EXTRA_STDLIB_WIDGETS[route] ?? []) {
    if (!stdlibWidgets.includes(widget)) {
      failures.push(
        `${route}: stdlib-js/${widget} is missing from dist — the route total is wrong`,
      );
      continue;
    }
    total += stdlibWidgetSizes(widget).gzip;
  }
  const budget = ROUTE_BUDGETS_GZIP[route];
  const status = total <= budget ? 'OK' : 'OVER';
  console.log(`  ${route}: ${fmtKb(total)} gzip (budget ${fmtKb(budget)}) — ${status}`);
  if (total > budget) {
    failures.push(`${route}: ${fmtKb(total)} gzip exceeds the ${fmtKb(budget)} route budget`);
  }
}

// ── Result ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error('\n[bundle-budget] FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n[bundle-budget] per-chunk, stdlib-widget and named route budgets OK.');
