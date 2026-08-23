#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitArg = args.find((arg) => arg.startsWith('--limit='));
const userIdArg = args.find((arg) => arg.startsWith('--user-id='));
const limit = Number(limitArg?.split('=')[1] || 200);
const userId = userIdArg?.split('=')[1] || '';

const legalResidenceFields = [
  'residence_country',
  'address_line_1',
  'address_line_2',
  'city',
  'state',
  'zip_code',
  'address_country',
];

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.');
  process.exit(1);
}

if (!Number.isFinite(limit) || limit <= 0) {
  console.error('`--limit` must be a positive number.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const cleanString = (value) => (typeof value === 'string' ? value.trim() : '');

const toCountryName = (value) => {
  const raw = cleanString(value);
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) {
    return regionNames.of(upper) || raw;
  }
  return raw;
};

const extractPlaidOwner = (identity) => {
  const accounts = Array.isArray(identity?.accounts) ? identity.accounts : [];
  const firstAccount = accounts[0] || {};
  const owners = Array.isArray(firstAccount.owners) ? firstAccount.owners : [];
  return owners[0] || null;
};

const resolvePlaidLegalResidence = (identity) => {
  const owner = extractPlaidOwner(identity);
  if (!owner) return null;

  const address = owner.addresses?.[0]?.data || owner.addresses?.[0] || owner.address || {};
  const line1 =
    cleanString(address.street) ||
    [cleanString(address.street_1), cleanString(address.street_2)].filter(Boolean).join(', ');
  const city = cleanString(address.city);
  const state = cleanString(address.region);
  const zipCode = cleanString(address.postal_code);
  const country = toCountryName(address.country);

  if (!line1 || !city || !state || !zipCode || !country) return null;

  return {
    residence_country: country,
    address_line_1: line1,
    address_line_2: cleanString(address.street_2) || null,
    city,
    state,
    zip_code: zipCode,
    address_country: country,
  };
};

const selectFields = `
  id,
  user_id,
  residence_country,
  address_line_1,
  address_line_2,
  city,
  state,
  zip_code,
  address_country,
  field_provenance,
  gps_full_address,
  gps_city,
  gps_state,
  gps_country,
  gps_zip_code
`;

const valuesDiffer = (current, next) => {
  if (next === null) return cleanString(current) !== '';
  return cleanString(current) !== cleanString(next);
};

const cloneProvenance = (value) => {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
};

const buildClearPatch = (row) => {
  const patch = {};
  for (const field of legalResidenceFields) {
    if (valuesDiffer(row[field], null)) patch[field] = null;
  }

  const provenance = cloneProvenance(row.field_provenance);
  let provenanceChanged = false;
  for (const field of legalResidenceFields) {
    if (provenance[field] !== 'self_declared') {
      provenance[field] = 'self_declared';
      provenanceChanged = true;
    }
  }
  if (provenanceChanged) patch.field_provenance = provenance;

  return patch;
};

const buildPlaidPatch = (row, plaidResidence) => {
  const patch = {};
  for (const field of legalResidenceFields) {
    const next = plaidResidence[field] || null;
    if (valuesDiffer(row[field], next)) patch[field] = next;
  }

  const provenance = cloneProvenance(row.field_provenance);
  let provenanceChanged = false;
  for (const field of legalResidenceFields) {
    const nextTier =
      field === 'address_line_2' && !plaidResidence.address_line_2
        ? 'self_declared'
        : 'bank_verified';
    if (provenance[field] !== nextTier) {
      provenance[field] = nextTier;
      provenanceChanged = true;
    }
  }
  if (provenanceChanged) patch.field_provenance = provenance;

  return patch;
};

async function loadFinancialIdentityByUserId(userIds) {
  if (userIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('user_financial_data')
    .select('user_id, identity_data')
    .in('user_id', userIds);

  if (error) {
    console.error('Failed to read user_financial_data:', error.message);
    process.exit(1);
  }

  return new Map((data || []).map((row) => [row.user_id, row.identity_data]));
}

async function main() {
  let query = supabase
    .from('onboarding_data')
    .select(selectFields)
    .or('residence_country.not.is.null,address_line_1.not.is.null,address_line_2.not.is.null,city.not.is.null,state.not.is.null,zip_code.not.is.null,address_country.not.is.null')
    .limit(limit);

  if (userId) {
    query = query.eq('user_id', userId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Failed to read onboarding_data:', error.message);
    process.exit(1);
  }

  const rows = data || [];
  const identityByUserId = await loadFinancialIdentityByUserId(
    [...new Set(rows.map((row) => row.user_id).filter(Boolean))]
  );

  let candidateCount = 0;
  let updatedCount = 0;

  console.log(`${apply ? 'Applying' : 'Dry-run'} Plaid-only onboarding legal residence repair over ${rows.length} row(s).`);
  console.log('Rule: rebuild legal residence from complete Plaid owner address, or clear it. gps_* stays untouched.');

  for (const row of rows) {
    const plaidResidence = resolvePlaidLegalResidence(identityByUserId.get(row.user_id));
    const patch = plaidResidence ? buildPlaidPatch(row, plaidResidence) : buildClearPatch(row);
    if (Object.keys(patch).length === 0) continue;

    patch.updated_at = new Date().toISOString();
    candidateCount += 1;
    console.log(`\n[user ${row.user_id}] ${plaidResidence ? 'plaid_rebuild' : 'clear_no_plaid_address'}`);
    console.log('patch', patch);
    if (row.gps_full_address || row.gps_city || row.gps_state || row.gps_country || row.gps_zip_code) {
      console.log('gps_context', {
        gps_full_address: row.gps_full_address || null,
        gps_city: row.gps_city || null,
        gps_state: row.gps_state || null,
        gps_country: row.gps_country || null,
        gps_zip_code: row.gps_zip_code || null,
      });
    }

    if (!apply) continue;

    const { error: updateError } = await supabase
      .from('onboarding_data')
      .update(patch)
      .eq('id', row.id);

    if (updateError) {
      console.error(`[user ${row.user_id}] update failed:`, updateError.message);
      continue;
    }

    updatedCount += 1;
  }

  console.log('\nSummary');
  console.log(`- Candidate rows: ${candidateCount}`);
  console.log(`- Updated rows: ${updatedCount}`);
  console.log(`- Mode: ${apply ? 'apply' : 'dry-run'}`);
}

main().catch((error) => {
  console.error('Unexpected failure running Plaid-only onboarding legal residence repair:', error);
  process.exit(1);
});
