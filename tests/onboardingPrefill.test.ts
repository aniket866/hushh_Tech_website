import { describe, expect, it } from 'vitest';

import {
  deriveBankCountry,
  resolveOnboardingPrefill,
  resolvePlaidLegalResidence,
} from '../src/services/onboarding/prefill';

const plaidIdentity = {
  accounts: [
    {
      owners: [
        {
          names: ['Plaid Person'],
          phone_numbers: [{ data: '+14155550123' }],
          addresses: [
            {
              data: {
                street: '1 Market St',
                city: 'San Francisco',
                region: 'CA',
                postal_code: '94105',
                country: 'US',
              },
            },
          ],
        },
      ],
    },
  ],
};

describe('onboarding prefill resolution', () => {
  it('prefers onboarding values over plaid, oauth, enriched, and location', () => {
    const resolved = resolveOnboardingPrefill({
      onboardingData: {
        legal_first_name: 'Saved',
        legal_last_name: 'User',
        phone_number: '9990001111',
        phone_country_code: '+91',
        address_line_1: '22 Saved St',
        city: 'Mumbai',
        state: 'MH',
        zip_code: '400001',
        address_country: 'India',
      },
      plaidIdentity,
      oauthMetadata: {
        given_name: 'OAuth',
        family_name: 'Name',
      },
      enrichedProfile: {
        city: 'Paris',
      },
      locationData: {
        country: 'United States',
        countryCode: 'US',
        state: 'California',
        city: 'San Francisco',
        postalCode: '94102',
        phoneDialCode: '+1',
      },
    });

    expect(resolved.values.legal_first_name).toBe('Saved');
    expect(resolved.values.phone_country_code).toBe('+91');
    expect(resolved.values.address_country).toBe('India');
    expect(resolved.sources.legal_first_name).toBe('onboarding');
    expect(resolved.sources.phone_country_code).toBe('onboarding');
  });

  it('uses plaid identity before oauth metadata for name and phone', () => {
    const resolved = resolveOnboardingPrefill({
      plaidIdentity,
      oauthMetadata: {
        given_name: 'OAuth',
        family_name: 'Fallback',
      },
    });

    expect(resolved.values.legal_first_name).toBe('Plaid');
    expect(resolved.values.legal_last_name).toBe('Person');
    expect(resolved.values.phone_country_code).toBe('+1');
    expect(resolved.values.phone_number).toBe('4155550123');
    expect(resolved.sources.legal_first_name).toBe('plaid');
    expect(resolved.sources.phone_number).toBe('plaid');
    // A bank mailing/residence address is not evidence of citizenship.
    expect(resolved.values.residence_country).toBe('United States');
    expect(resolved.values.address_country).toBe('United States');
    expect(resolved.values.citizenship_country).toBeUndefined();
  });

  it('fills missing address and country fields from enriched data and location last', () => {
    const resolved = resolveOnboardingPrefill({
      enrichedProfile: {
        address_line_1: '44 Rue Example',
        city: 'Paris',
        state: 'IDF',
        zip_code: '75001',
        address_country: 'France',
      },
      locationData: {
        country: 'United States',
        countryCode: 'US',
        state: 'California',
        city: 'San Francisco',
        postalCode: '94102',
        phoneDialCode: '+1',
      },
    });

    expect(resolved.values.address_line_1).toBe('44 Rue Example');
    expect(resolved.values.city).toBe('Paris');
    expect(resolved.values.address_country).toBe('France');
    expect(resolved.values.citizenship_country).toBeUndefined();
    expect(resolved.values.residence_country).toBeUndefined();
    expect(resolved.values.phone_country_code).toBe('+1');
    expect(resolved.sources.address_line_1).toBe('enriched');
    expect(resolved.sources.phone_country_code).toBe('location');
  });

  it('derives bank country from address first, then residence, then saved bank country, then US', () => {
    expect(deriveBankCountry({
      addressCountry: 'India',
      residenceCountry: 'United States',
      savedBankCountry: 'SG',
    })).toBe('IN');

    expect(deriveBankCountry({
      addressCountry: '',
      residenceCountry: 'United Kingdom',
      savedBankCountry: 'SG',
    })).toBe('GB');

    expect(deriveBankCountry({
      addressCountry: '',
      residenceCountry: '',
      savedBankCountry: 'CA',
    })).toBe('CA');

    expect(deriveBankCountry({
      addressCountry: '',
      residenceCountry: '',
      savedBankCountry: '',
    })).toBe('US');
  });

  it('returns a complete Plaid legal residence when the bank owner address is complete', () => {
    expect(resolvePlaidLegalResidence(plaidIdentity)).toEqual({
      residence_country: 'United States',
      address_line_1: '1 Market St',
      address_line_2: '',
      city: 'San Francisco',
      state: 'CA',
      zip_code: '94105',
      address_country: 'United States',
    });
  });

  it('does not create a legal residence from incomplete Plaid owner addresses', () => {
    const incompletePlaidIdentity = {
      accounts: [
        {
          owners: [
            {
              names: ['Partial Person'],
              addresses: [
                {
                  data: {
                    street: '1 Missing Postal St',
                    city: 'San Francisco',
                    region: 'CA',
                    country: 'US',
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    expect(resolvePlaidLegalResidence(incompletePlaidIdentity)).toBeNull();
  });
});
