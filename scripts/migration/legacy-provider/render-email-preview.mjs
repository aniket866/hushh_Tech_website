// Dev-only: render the redesigned Hushh emails to standalone HTML for visual QA.
// Bundles the Deno edge-function templates with esbuild, inlines cid: icons as
// data-URIs so the preview is faithful, and writes HTML into tmp/email-preview/.
import { build } from "esbuild";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, "tmp", "email-preview");
const FN = path.join(ROOT, "supabase", "functions");

async function bundle(entry) {
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const dataUrl = "data:text/javascript;base64," + Buffer.from(res.outputFiles[0].text).toString("base64");
  return import(dataUrl);
}

function inlineIcons(html, assetsMod) {
  // map cid:<contentId> -> data:image/png;base64,<...>
  const keys = ["logo", "home", "x", "youtube", "linkedin", "facebook", "calendar", "bank", "shield", "analytics", "quiz", "calendar-check"];
  let out = html;
  for (const k of keys) {
    const a = assetsMod.getInlineAsset(k);
    out = out.split(`cid:${a.contentId}`).join(`data:${a.mimeType};base64,${a.base64Data}`);
  }
  return out;
}

const sampleDocs = [
  "Limited Partnership Agreement — Alpha Fund",
  "Private Placement Memorandum",
  "Subscription Agreement",
  "Investor Prospectus",
];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const assetsMod = await bundle(path.join(FN, "_shared", "emailInlineAssets.ts"));

// 1) NDA admin internal notification
const adminMod = await bundle(path.join(FN, "nda-signed-notification", "template.ts"));
const adminHtml = inlineIcons(
  adminMod.buildNDANotificationHtml({
    signerName: "Jhumma Kumari",
    signerEmail: "jhumma.kumari@example.com",
    signedDate: "23 June 2026, 21:58 IST",
    ndaVersion: "v2.3",
    signerIp: "203.0.113.42",
    pdfUrl: "https://hushhtech.com/nda-admin",
    userId: "a1b2c3d4-5e6f-7890-abcd-ef1234567890",
    documentsAcknowledged: sampleDocs,
  }),
  assetsMod,
);
await writeFile(path.join(OUT, "nda-admin.html"), adminHtml);

// 2) Signer confirmation email
const userMod = await bundle(path.join(FN, "nda-signed-notification", "userTemplate.ts"));
const userHtml = inlineIcons(
  userMod.buildNDAUserConfirmationHtml({
    signerName: "Jhumma Kumari",
    signerEmail: "jhumma.kumari@example.com",
    signedDate: "23 June 2026, 21:58 IST",
    ndaVersion: "v2.3",
    pdfAttached: true,
    pdfUrl: "https://hushhtech.com/my-documents",
    documentsAcknowledged: sampleDocs,
    signedDocuments: sampleDocs,
    profileUrl: "https://hushhtech.com/onboarding/meet-ceo",
  }),
  assetsMod,
);
await writeFile(path.join(OUT, "nda-signer.html"), userHtml);

console.log("WROTE:");
console.log(path.join(OUT, "nda-admin.html"));
console.log(path.join(OUT, "nda-signer.html"));
