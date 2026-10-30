// Reusable driver for NEXT HMI visual checks.
//
//   const h = require('<repo>/.claude/skills/visual-check/harness.js');
//   const { ed, close } = await h.bootEditor();
//   await h.selectTreeNode(ed, 'Left sidebar');
//   await h.shotEl(h.propsPanel(ed), 'panel');
//   await close();
//
// Everything below is a fact verified against the running app, not a guess.

const os = require('os');
const path = require('path');
const { createRequire } = require('module');

// Playwright lives in the persistent cache dir created by setup.sh, not next
// to this file (the skill folder is in the repo and has no node_modules).
const PW_HOME = process.env.PW_HOME || path.join(os.homedir(), '.cache/nexthmi-visual-check');
const { chromium } = createRequire(path.join(PW_HOME, 'package.json'))('playwright');

// Screenshots land here. Override with OUT=… when driving from a scratchpad.
const OUT = process.env.OUT || process.cwd();

// The dev runner serves plain HTTP on :8000 (Vite, proxying the API on :8001).
// HTTPS is opt-in from Settings, and its cert — self-signed, from
// <runtime_home>/tls/ — is why every context still needs ignoreHTTPSErrors.
// Override with BASE=https://localhost:8000 against an install that has it on.
const BASE = process.env.BASE || 'http://localhost:8000';
const DEV_PASSWORD = 'dev';

/**
 * Launch Chromium with the settings this app needs.
 *
 * `dpr` raises the device pixel ratio. Anything small enough that its shape is
 * the thing under test — an 11px badge glyph, a diagnostic dot — is unjudgeable
 * from a 1x crop, because upscaling a 12-pixel-wide PNG only blurs it. Shoot at
 * `dpr: 3` instead and read the crop directly.
 *
 * `showScrollbars`: Playwright starts headless Chromium with `--hide-scrollbars`,
 * so every element reports a 0px scrollbar gutter and no bar is painted — even
 * a plain `overflow: scroll` div. A check that is *about* a scrollbar must
 * drop that flag, or it cannot tell a working bar from a missing one.
 */
async function launch({ width = 1600, height = 1100, dpr = 1, showScrollbars = false } = {}) {
  const browser = await chromium.launch(
    showScrollbars ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {},
  );
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    ignoreHTTPSErrors: true,
  });
  return { browser, context };
}

/** Attach error logging BEFORE navigating — a shell can render while a fetch 500s. */
function watchErrors(page, tag = '') {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`CONSOLE ERROR${tag ? ' ' + tag : ''}:`, m.text());
  });
  page.on('pageerror', (e) => console.log(`PAGE ERROR${tag ? ' ' + tag : ''}:`, e.message));
}

/**
 * Dismiss the runtime's "Enter fullscreen?" prompt. It mounts after
 * `networkidle` and again on every runtime navigation, and its backdrop takes
 * every click — a forced click lands on it and nothing opens. Polls until the
 * backdrop has been gone for a few consecutive checks.
 */
async function dismissFullscreenPrompt(page) {
  let gone = 0;
  for (let i = 0; i < 30 && gone < 3; i++) {
    const backdrop = page.locator('.fullscreen-prompt-backdrop');
    if (await backdrop.count()) {
      gone = 0;
      await backdrop.first().click({ force: true, position: { x: 5, y: 5 } }).catch(() => {});
    } else {
      gone += 1;
    }
    await page.waitForTimeout(300);
  }
}

/**
 * Sign in, open the editor tab, and return it ready to drive.
 * Resolves the whole gauntlet: password gate → Projects list → new-tab editor.
 */
async function bootEditor(opts = {}) {
  const { browser, context } = await launch(opts);
  const page = await context.newPage();
  watchErrors(page);

  await page.goto(`${BASE}/editor`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // Manager sign-in gate. First run with no password set accepts and *sets*
  // whatever is submitted.
  const pw = page.locator('input[type="password"]');
  if (await pw.count()) {
    await pw.fill(process.env.DEV_PASSWORD || DEV_PASSWORD);
    await page.locator('button:has-text("Sign in")').click();
    await page.waitForTimeout(1500);
  }

  // A freshly-registered project (e.g. one this script just added to the
  // manifest) lands STOPPED and has no "Open editor" button at all yet —
  // only "Start". Click it first if present/enabled; a no-op against the
  // usual already-running testbench project.
  const startBtn = page.locator('button:has-text("Start")').first();
  if ((await startBtn.count()) && (await startBtn.isEnabled().catch(() => false))) {
    await startBtn.click();
    // A project below the current formatVersion (a raw project-example copy
    // included) asks "Upgrade '<name>'?" first and stays STOPPED until confirmed.
    const upgrade = page.locator('button:has-text("Upgrade & start")');
    if (await upgrade.waitFor({ timeout: 1500 }).then(() => true, () => false)) await upgrade.click();
    await page.waitForTimeout(3000);
  }

  // Post-login landing page is /projects, not the editor. "Open editor" opens
  // a NEW TAB — catch it with waitForEvent('page'), not waitForNavigation.
  let ed = page;
  const openBtn = page.locator('button:has-text("Open editor")').first();
  if (await openBtn.count()) {
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 8000 }).catch(() => null),
      openBtn.click(),
    ]);
    if (popup) {
      ed = popup;
      watchErrors(ed, '(editor)');
    }
  }
  await ed.waitForLoadState('networkidle').catch(() => {});
  await ed.waitForTimeout(2500);
  console.log('editor url:', ed.url()); // expect /editor/<projectId>/editor

  return { browser, context, page, ed, close: () => browser.close() };
}

// ── Editor surfaces ──────────────────────────────────────────────────────────

/** The right-hand properties panel's scroll container. */
const propsPanel = (ed) => ed.locator('.cfg-props-panel__scroll').first();

/** The panel's header block ("Shell area / Left sidebar", "Page / …", …). */
const panelHeader = (ed) => ed.locator('.cfg-panel-header').first();

/** The live HMI preview iframe holding the canvas. */
const canvas = (ed) => ed.frameLocator('iframe').first();

/**
 * Select a node in the left widget tree by its visible label — works for the
 * shell-area section rows ('Header', 'Left sidebar', 'Right sidebar', 'Footer'),
 * 'Settings', 'Global Events', and page rows.
 *
 * Container widget rows are still unreliable (a click can open the Add Widget
 * context menu) — for a widget, click it in the canvas with { force: true }.
 */
async function selectTreeNode(ed, label) {
  const row = ed.locator(`text=${label}`).first();
  await row.waitFor({ timeout: 10000 });
  await row.click();
  await ed.waitForTimeout(1200);
}

/** Click a widget in the canvas. The selection overlay intercepts pointer
 *  events, hence force. Prefer [data-widget-id] over text for a specific one.
 *
 *  CAVEAT: the click lands on the element's *centre*, and the editor selects
 *  whatever widget is topmost at that point — so locating a container and
 *  clicking it selects a nested child instead. Use `selectWidgetByName` when
 *  the selection has to be a specific widget. */
async function selectCanvasWidget(ed, selector) {
  await canvas(ed).locator(selector).first().click({ timeout: 5000, force: true });
  await ed.waitForTimeout(600);
}

/**
 * The rendered element of one canvas widget — what to screenshot or measure.
 *
 * `[data-widget-id]` itself is on `.hmi-preview-node` (`display: contents`), so
 * it has an empty rect and `shotEl` fails with "Node is either not visible or
 * not an HTMLElement". `> *` is not enough either: a `$component` instance
 * nests a second preview node, so the first real box is a *descendant*, not a
 * child. Matching `.hmi-component`/`.hmi-container` under it skips however many
 * wrappers there are.
 */
const widgetEl = (ed, id) =>
  canvas(ed)
    .locator(`[data-widget-id="${id}"] :is(.hmi-component, .hmi-container)`)
    .first();

/**
 * Select a widget by its **name** through the tree's search box — the only
 * reliable way to land on one specific widget.
 *
 * The tree collapses page subtrees, so a plain `getByText(name)` finds nothing
 * until the page is expanded; filtering reveals the row wherever it lives, and
 * a container row reached this way selects rather than opening the Add Widget
 * menu. Names come from the project's `pages/*.json` (`name`, not `id`).
 */
async function selectWidgetByName(ed, name) {
  await ed.getByPlaceholder('Search tree').fill(name);
  await ed.waitForTimeout(1200);
  // Not getByText(name, { exact: true }): the search wraps every match in a
  // <mark> whose own text is exactly `name`, so it lands in a sibling row
  // ("Tanks & CIP" for "Tanks"). Match the whole label instead.
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await ed.locator('.cfg-tree-item__label', { hasText: exact }).first().click();
  await ed.waitForTimeout(1200);
}

// ── Property rows ────────────────────────────────────────────────────────────

/**
 * One property row (a `FieldGroup`) by its label.
 *
 * NOTE: `.cfg-field-group:has(> * >> text="X")` is NOT valid — Playwright's CSS
 * parser rejects the nested `>>`. Use the options object as done here.
 */
const fieldGroup = (ed, label) =>
  propsPanel(ed).locator('.cfg-field-group', { hasText: label }).first();

/** The source pill button on a row — present only on source-capable fields. */
const sourcePill = (ed, label) =>
  fieldGroup(ed, label).locator('.cfg-source-pill-wrapper button').first();

/** True when the row offers a property-source picker at all (vs. a static PropRow). */
const isSourceCapable = async (ed, label) => (await sourcePill(ed, label).count()) > 0;

/**
 * Open a row's source menu and return the option labels it offers.
 * Useful as an assertion on its own: the list is type-derived, so a Color field
 * yields far fewer entries than a String one.
 */
async function openSourceMenu(ed, label) {
  await sourcePill(ed, label).click();
  await ed.waitForTimeout(500);
  return ed.locator('.cfg-source-pill__popup .cfg-source-pill__option-label').allInnerTexts();
}

/**
 * Dismiss the source-pill popup.
 *
 * Escape does NOT close it — leaving it open makes the next row's pill
 * unclickable ("subtree intercepts pointer events") and the run times out.
 * Clicking the panel header does close it.
 */
async function closePopup(ed) {
  await panelHeader(ed).click({ force: true });
  await ed.waitForTimeout(400);
}

/** Switch a row to a named source, e.g. 'Variable', 'If Condition', 'Static Value'. */
async function setSource(ed, label, sourceName) {
  await sourcePill(ed, label).click();
  await ed.waitForTimeout(400);
  await ed
    .locator('.cfg-source-pill__popup .cfg-source-pill__option-label', {
      hasText: new RegExp(`^${sourceName}$`),
    })
    .first()
    .click();
  await ed.waitForTimeout(900);
}

// ── Capture ──────────────────────────────────────────────────────────────────

/** Full-page shot. Needed for source menus and any other portalled popup —
 *  they render outside the panel, so an element shot or a clip crops them. */
const shot = (ed, name) => ed.screenshot({ path: path.join(OUT, `${name}.png`) });

/** Single-element shot — smaller and far easier to read for one panel/field. */
const shotEl = (locator, name) => locator.screenshot({ path: path.join(OUT, `${name}.png`) });

/**
 * A tight, documentation-style crop of the widget tree: from the search bar
 * down to the bottom of the last visible row — NOT `shotEl(canvas(ed).first())`,
 * which captures `.cfg-tree`'s full flex-stretched height (as tall as the
 * viewport, mostly blank below the last row). Use `launch({ dpr: 2 })` to match
 * the resolution existing doc images (e.g. `editor-page-tree.png`) were shot at.
 */
async function shotTreeClipped(ed, name) {
  const treeBox = await ed.locator('.cfg-tree').first().boundingBox();
  const rows = ed.locator('.cfg-tree-item');
  const lastRowBox = await rows.nth((await rows.count()) - 1).boundingBox();
  await ed.screenshot({
    path: path.join(OUT, `${name}.png`),
    clip: {
      x: treeBox.x,
      y: treeBox.y,
      width: treeBox.width,
      height: lastRowBox.y + lastRowBox.height - treeBox.y + 8,
    },
  });
}

module.exports = {
  BASE,
  OUT,
  PW_HOME,
  chromium,
  launch,
  watchErrors,
  dismissFullscreenPrompt,
  bootEditor,
  propsPanel,
  panelHeader,
  canvas,
  selectTreeNode,
  selectCanvasWidget,
  selectWidgetByName,
  widgetEl,
  fieldGroup,
  sourcePill,
  isSourceCapable,
  openSourceMenu,
  closePopup,
  setSource,
  shot,
  shotEl,
  shotTreeClipped,
};
