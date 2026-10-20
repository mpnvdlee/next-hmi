import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FolderEntry, TreeNode, VariableEntry } from '@shared/types/datasource';
import { isFolder } from '@shared/types/datasource';
import fixture from '../../../shared/types/__fixtures__/opcuaBrowseProfiles.json';
import { buildFromBrowse, type BrowseNode } from './datasourceTreeHelpers';

/**
 * The frontend half of the PLC-profile contract (see the backend's
 * tests/opcua_plc_profiles.py). The backend proves each PLC shape browses to
 * `browse`; this proves `browse` imports to `tree`; the backend then runs
 * `tree` as a live datasource. A change on either side breaks one half, and
 * the diff says which.
 *
 * `NEXTHMI_WRITE_FIXTURE=1 npm test -- --run <this file>` rewrites `tree`
 * from the current buildFromBrowse — deliberately, after reading the diff.
 */

type Profile = { title: string; browse: BrowseNode & { show_root?: boolean }; tree: TreeNode[] };
const profiles = fixture as unknown as Record<string, Profile>;
const FIXTURE_FILE = path.resolve(
  __dirname,
  '../../../shared/types/__fixtures__/opcuaBrowseProfiles.json',
);

function importTree(profile: Profile): TreeNode[] {
  const root = profile.browse;
  return buildFromBrowse(root.show_root ? [root] : (root.children ?? []), new Map());
}

function find(nodes: TreeNode[], names: string[]): TreeNode | undefined {
  let level = nodes;
  let found: TreeNode | undefined;
  for (const name of names) {
    found = level.find((n) => (isFolder(n) ? n.name : n.display_name) === name);
    if (!found) return undefined;
    level = isFolder(found) ? found.children : [];
  }
  return found;
}

function* walk(nodes: TreeNode[]): Generator<TreeNode> {
  for (const node of nodes) {
    yield node;
    if (isFolder(node)) yield* walk(node.children);
  }
}

if (process.env.NEXTHMI_WRITE_FIXTURE === '1') {
  for (const profile of Object.values(profiles)) profile.tree = importTree(profile);
  fs.writeFileSync(FIXTURE_FILE, JSON.stringify(profiles, null, 2) + '\n');
}

describe.each(Object.entries(profiles))('%s browse import', (_name, profile) => {
  it('imports to the tree the backend runs live', () => {
    expect(importTree(profile)).toEqual(profile.tree);
  });

  it('never imports a node with a type as a folder, or a typed leaf without one', () => {
    for (const node of walk(importTree(profile))) {
      if (isFolder(node)) continue;
      expect((node as VariableEntry).data_type, (node as VariableEntry).display_name).toBeTruthy();
      expect((node as VariableEntry).node_id).toBeTruthy();
    }
  });

  it('starts every imported tag disabled, for the user to opt in', () => {
    for (const node of walk(importTree(profile))) {
      if (!isFolder(node)) expect((node as VariableEntry).enabled).toBe(false);
    }
  });
});

describe('PLC-specific imports', () => {
  it('opens a CODESYS struct into a folder of its members', () => {
    const axis = find(profiles.codesys.tree, ['Application', 'GVL_Robot', 'stAxis']);
    expect(axis?.kind).toBe('folder');
    expect((axis as FolderEntry).children.map((c) => (c as VariableEntry).display_name)).toEqual([
      'rPos',
      'bHomed',
    ]);
  });

  it('imports a CODESYS ENUM as an Int32 tag, not a struct', () => {
    const state = find(profiles.codesys.tree, ['Application', 'GVL_Robot', 'eControlState']);
    expect(state).toMatchObject({ kind: 'variable', data_type: 'Int32' });
  });

  it('keeps an S7 UDT nested inside a UDT as folders all the way down', () => {
    const temp = find(profiles.s7_1500.tree, [
      'PLC_1',
      'DataBlocksGlobal',
      'DB_Machine',
      'Battery',
      'Cell',
      'Temp',
    ]);
    expect(temp).toMatchObject({ kind: 'variable', data_type: 'Float' });
  });

  it('marks a fixed array with its length and a dynamic one without', () => {
    expect(
      find(profiles.s7_1500.tree, ['PLC_1', 'DataBlocksGlobal', 'DB_Machine', 'Levels']),
    ).toMatchObject({ is_array: true, array_length: 8 });
    const buffer = find(profiles.twincat.tree, ['PLC1', 'GVL', 'aBuffer']) as VariableEntry;
    expect(buffer.is_array).toBe(true);
    expect(buffer.array_length).toBeUndefined();
  });

  it('imports an array of structs as an array folder of element folders', () => {
    const points = find(profiles.generic.tree, ['Plant', 'Points']) as FolderEntry;
    expect(points.kind).toBe('folder');
    expect(points.is_array).toBe(true);
    expect(points.children.map((c) => (c as FolderEntry).name)).toEqual(['[0]', '[1]']);
    expect(find(profiles.generic.tree, ['Plant', 'Points', '[1]', 'y'])).toMatchObject({
      kind: 'variable',
      data_type: 'Double',
    });
  });

  it('walks a struct nested five deep', () => {
    expect(
      find(profiles.generic.tree, ['Plant', 'L1', 'L2', 'L3', 'L4', 'L5', 'Value']),
    ).toMatchObject({ kind: 'variable', data_type: 'Double' });
  });

  it('carries non-ASCII names through unchanged', () => {
    expect(find(profiles.bnr.tree, ['Modules', 'Program', '温度'])).toBeDefined();
    expect(find(profiles.bnr.tree, ['Modules', 'Global', 'gMachine', 'Füllstand'])).toBeDefined();
  });

  it('imports no method of any profile', () => {
    for (const profile of Object.values(profiles)) {
      for (const node of walk(profile.tree)) {
        const name = isFolder(node) ? node.name : node.display_name;
        expect(['Reset', 'M_Reset', 'InputArguments', 'OutputArguments']).not.toContain(name);
      }
    }
  });
});
