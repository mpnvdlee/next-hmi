// Template — copy to $SCRATCHPAD/drive.js, adapt, run with:
//   OUT=$SCRATCHPAD node drive.js
//
// Everything generic (HTTPS, sign-in, the new editor tab, panel/pill selectors)
// lives in harness.js. Keep this file down to the specific thing being checked.
//
// The copy runs from the scratchpad, not the repo, so the harness is resolved
// from the repo root rather than relative to this file.
const { execSync } = require('node:child_process');
const path = require('node:path');

function findRepoRoot() {
  if (process.env.NEXTHMI_REPO) return process.env.NEXTHMI_REPO;
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Set NEXTHMI_REPO to the repo root: NEXTHMI_REPO=/path/to/next-hmi OUT=$SCRATCHPAD node drive.js');
  }
}
const h = require(path.join(findRepoRoot(), '.claude/skills/visual-check/harness.js'));

(async () => {
  const { ed, close } = await h.bootEditor();

  // ── adapt from here ──────────────────────────────────────────────────────
  await h.selectTreeNode(ed, 'Left sidebar');

  // Static state of the panel.
  await h.shotEl(h.propsPanel(ed), 'panel');

  // A row's source menu (full-page — the popup portals outside the panel).
  console.log('sources:', await h.openSourceMenu(ed, 'Enabled'));
  await h.shot(ed, 'menu-enabled');
  await h.closePopup(ed); // Escape does NOT close it

  // Drive a row to a binding and capture the result.
  await h.setSource(ed, 'Enabled', 'Variable');
  await h.shotEl(h.propsPanel(ed), 'panel-bound');
  // ── to here ──────────────────────────────────────────────────────────────

  await close();
})();
