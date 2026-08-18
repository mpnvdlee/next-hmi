import * as stub from '@enterprise';
import * as direct from '../registry';

/**
 * The open-source half of the edition seam. Its whole job is to be empty, so
 * that is what gets asserted — a stub that quietly grew a real export would put
 * enterprise behaviour into the public bundle.
 */

describe('open-source enterprise stub', () => {
  it('contributes no settings panels', () => {
    expect(direct.enterpriseSettingsPanels).toEqual([]);
  });

  it('contributes no admin sections', () => {
    expect(direct.enterpriseAdminSections).toEqual([]);
  });

  it('contributes no session-reset callbacks', () => {
    expect(direct.enterpriseSessionResets).toEqual([]);
  });

  it('wraps the manager dashboard in no gates', () => {
    // An `ee` build holds it behind runtime activation here; the public build
    // has nothing to activate, so the dashboard renders directly.
    expect(direct.enterpriseAppGates).toEqual([]);
  });

  it('exports nothing but the documented seam arrays', () => {
    expect(Object.keys(direct).sort()).toEqual([
      'enterpriseAdminSections',
      'enterpriseAppGates',
      'enterpriseSessionResets',
      'enterpriseSettingsPanels',
    ]);
  });

  it('is what the @enterprise alias resolves to under the default edition', () => {
    expect(stub.enterpriseSettingsPanels).toBe(direct.enterpriseSettingsPanels);
    expect(stub.enterpriseAdminSections).toBe(direct.enterpriseAdminSections);
    expect(stub.enterpriseSessionResets).toBe(direct.enterpriseSessionResets);
    expect(stub.enterpriseAppGates).toBe(direct.enterpriseAppGates);
  });
});
