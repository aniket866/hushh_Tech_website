# Supabase Native Cutover Gate

Issue [#1950](https://github.com/hushh-labs/hushh_Tech_website/issues/1950) requires zero Supabase runtime use. Native deletion readiness is governed by [`migration/native/supabase-native-cutover.v1.json`](../../../migration/native/supabase-native-cutover.v1.json).

## Current truth

- Hushh Tech removed its tracked Capacitor iOS and Android shells in PR #665 and is currently web-only.
- The retired shells used `ai.hushh.app` on both platforms. Android source last recorded version code 11. The iOS project setting was 11 while its tracked Info.plist still said 5, so the real highest shipped legacy build is not inferred from source.
- Hussh One's maintained native app lives in `hushh-labs/hushh-research`, uses `com.hushh.app` on iOS, and is a separate product. It cannot satisfy the Hushh Tech replacement-build gate.
- No replacement Hushh Tech store build or forced minimum-version proof exists yet. Supabase deletion therefore remains blocked.

## Required proof

Both iOS and Android must preserve the legacy application identity, use Firebase `hushh-pda`, call only GCP-backed Hushh Tech APIs, and reach 100% production store availability. App Store Connect and Play Console must first attest the highest Supabase-capable build; each new minimum supported build must be newer than that store-attested value. A store-attested value can never be below tracked source build 11. For iOS, the project build 11 and Info.plist build 5 disagreement is handled conservatively by keeping 11 as the source floor until App Store Connect proves the real highest build.

Deletion evidence must include the exact shipped artifact, store listing, server/client minimum-version response, forced-upgrade end-to-end run, and a native network trace with zero Supabase requests. Every proof, including `network_trace_sha256`, is bound by SHA-256. The minimum-version contract is HTTP 426 with `CLIENT_UPGRADE_REQUIRED` and must fail closed on both the server and client. Hashes written into the JSON are not trusted as live proof: a credentialed App Store Connect, Play Console, artifact, and network attestation executor must be reviewed and checked in before deletion readiness can ever pass.

Validate the contract:

```bash
npm run migration:native:contract
```

The destructive cutover gate intentionally fails today, including when a caller fills the JSON with plausible-looking hashes:

```bash
npm run migration:native:deletion-ready
```

Do not delete or disable Supabase until the second command passes from an exact green release head and its store evidence has been independently re-read.
