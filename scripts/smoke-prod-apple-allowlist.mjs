import { execFileSync } from 'node:child_process';
import { fetchProdAppleServiceId, verifyProdAppleOAuthAllowlist } from './shared/firebaseAuthSmoke.mjs';

let serviceId;
try {
  const token = execFileSync('gcloud', ['auth', 'print-access-token'], {
    encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  serviceId = await fetchProdAppleServiceId(token);
} catch {
  // Neither gcloud output nor provider config may appear in deploy logs.
  console.error('Production Firebase Apple provider lookup failed.');
  process.exitCode = 1;
}

if (serviceId) {
  try {
    const result = await verifyProdAppleOAuthAllowlist(serviceId);
    console.log(JSON.stringify(result));
  } catch {
    // Apple's response may contain request context. Keep deploy logs credential-free.
    console.error('Production Apple OAuth redirect allowlist probe failed.');
    process.exitCode = 1;
  }
}
