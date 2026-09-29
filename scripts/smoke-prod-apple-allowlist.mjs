import { verifyProdAppleOAuthAllowlist } from './shared/firebaseAuthSmoke.mjs';

try {
  const result = await verifyProdAppleOAuthAllowlist('com.hushh.app.signin');
  console.log(JSON.stringify(result));
} catch {
  // Apple's response may contain request context. Keep deploy logs credential-free.
  console.error('Production Apple OAuth redirect allowlist probe failed.');
  process.exitCode = 1;
}
