import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * v2: every investor supplies legal residence + full address. Bank/Plaid data
 * can prefill legal residence/address; live location is displayed and stored
 * separately and never fills legal KYC fields.
 */
describe('step-3 residence visibility — full investor address', () => {
  const logic = read('src/pages/onboarding/step-3/logic.ts');
  const ui = read('src/pages/onboarding/step-3/ui.tsx');

  it('requires legal residence and full address before continuing', () => {
    const canContinue = logic.slice(
      logic.indexOf('const canContinue = Boolean('),
      logic.indexOf('const isErrorStatus'),
    );

    expect(canContinue).toContain('citizenshipCountry &&');
    expect(canContinue).toContain('residenceCountry &&');
    expect(canContinue).toContain('addressLine1.trim() &&');
    expect(canContinue).toContain('addressCity.trim() &&');
    expect(canContinue).toContain('addressState.trim() &&');
    expect(canContinue).toContain('zipCode.trim() &&');
    expect(canContinue).toContain('(!hasBankResidence || residenceAttested)');
  });

  it('renders residence selector, full address fields, and location prefill affordance', () => {
    expect(ui).toContain('Use current location');
    expect(ui).toContain('onChange={(e) => s.handleResidenceChange(e.target.value)}');
    expect(ui).toContain('onChange={(e) => s.handleAddressLine1Change(e.target.value)}');
    expect(ui).toContain('onChange={(e) => s.handleAddressCityChange(e.target.value)}');
    expect(ui).toContain('onChange={(e) => s.handleAddressStateChange(e.target.value)}');
    expect(ui).toContain('onChange={(e) => s.handleZipCodeChange(e.target.value)}');
    expect(ui).not.toContain('s.hasBankResidence && (\n                <div className="grid gap-3 border-t');
  });

  it('keeps bank-sourced residence fields read-only and prevents GPS legal-field prefill', () => {
    expect(logic).toContain("if (fieldSources['residence_country'] === 'plaid') return;");
    expect(logic).toContain("if (fieldSources['address_line_1'] === 'plaid') return;");
    const locationHandler = logic.slice(
      logic.indexOf('const applyDetectedLocation'),
      logic.indexOf('/* ─── GPS refresh ─── */'),
    );
    expect(locationHandler).toContain('setDetectedLocation');
    expect(locationHandler).not.toContain('setResidenceCountry(');
    expect(locationHandler).not.toContain('setAddressLine1(');
    expect(locationHandler).not.toContain('setAddressCity(');
    expect(locationHandler).not.toContain('setAddressState(');
    expect(locationHandler).not.toContain('setZipCode(');
    expect(locationHandler).not.toContain('setCitizenshipCountry(');
  });

  it('persists residence and address fields for preview and real saves', () => {
    expect(logic).toContain('residence_country: residenceCountry');
    expect(logic).toContain('address_line_1: addressLine1.trim()');
    expect(logic).toContain('city: addressCity.trim()');
    expect(logic).toContain('state: addressState.trim()');
    expect(logic).toContain('zip_code: zipCode.trim()');
    expect(logic).toContain('addressCountry: addressCountry || residenceCountry');
    expect(logic).not.toContain('Object.assign(payload, buildStep3LegalResidenceClearPayload())');
  });
});
