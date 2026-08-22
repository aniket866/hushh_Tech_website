// Build tokenized signing templates from the blank public fund documents.
//
// Reads the 4 blank docx in public/fund-documents/, injects signature-block
// tokens ({{GP_SIGNATURE}}, {{GP_DATE}}, {{LP_SIGNATURE}}, {{LP_NAME}},
// {{LP_DATE}}) — adding an LP block to the Delaware feeder LPA and appending a
// full acknowledgement+signature page to the Prospectus and PPM — then writes:
//   1. supabase/functions/nda-signed-notification/templates/<name>.docx   (review)
//   2. supabase/functions/nda-signed-notification/fundDocTemplates.base64.ts (runtime)
//
// The runtime signer (signFundDocs.ts) only swaps tokens -> real values, so all
// the fragile docx surgery happens here, once, and is verifiable.
//
// Run: node scripts/build-signed-doc-templates.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "public", "fund-documents");
const OUT_DIR = join(ROOT, "supabase", "functions", "nda-signed-notification", "templates");
mkdirSync(OUT_DIR, { recursive: true });

const FONT =
  'w:ascii="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman"';

function para(text, { bold = false, italic = false, before = null, after = 200, jc = "both", pageBreak = false, sz = 24 } = {}) {
  const sp = `<w:spacing${before != null ? ` w:before="${before}"` : ""}${after != null ? ` w:after="${after}"` : ""}/>`;
  const pPr = `<w:pPr>${sp}<w:jc w:val="${jc}"/></w:pPr>`;
  const rPr = `<w:rPr><w:rFonts ${FONT}/>${bold ? "<w:b/><w:bCs/>" : ""}${italic ? "<w:i/><w:iCs/>" : ""}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`;
  const brk = pageBreak ? `<w:r><w:br w:type="page"/></w:r>` : "";
  const run = text != null ? `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>` : "";
  return `<w:p>${pPr}${brk}${run}</w:p>`;
}
function spacer(before = 400) {
  return `<w:p><w:pPr><w:spacing w:before="${before}"/></w:pPr></w:p>`;
}

// A small monospace-ish certificate line (9pt).
function certLine(text, { bold = false, italic = false, after = 60, jc = "left" } = {}) {
  return para(text, { bold, italic, after, jc, sz: 18 });
}

// Tokenized Electronic Signature Certificate appended to every signed document.
// {{SIG_*}} tokens are filled per-signer at runtime; the document fingerprint is
// the SHA-256 of the exact source document version, baked in here.
function certificateBlock(docHashHex) {
  return (
    para("ELECTRONIC SIGNATURE CERTIFICATE", { bold: true, jc: "center", before: 0, after: 140, pageBreak: true }) +
    certLine(
      "This document was executed by electronic signature under the U.S. ESIGN Act (15 U.S.C. ch. 96) and the applicable Uniform Electronic Transactions Act (UETA). The signer adopted their typed name as their legally binding signature.",
      { after: 160, jc: "both" }
    ) +
    certLine("Signature ID:        {{SIG_ID}}") +
    certLine("Signer:              {{SIG_NAME}} ({{SIG_EMAIL}})") +
    certLine("Signature method:    Typed name / click-to-sign (“Adopt and Sign”)") +
    certLine("Signed (UTC):        {{SIG_SIGNED_UTC}}") +
    certLine("Signed (local):      {{SIG_SIGNED_LOCAL}}") +
    certLine("IP address:          {{SIG_IP}}") +
    certLine("Device:              {{SIG_DEVICE}}") +
    certLine("Electronic consent:  ACCEPTED — {{SIG_CONSENT}}") +
    certLine("Document fingerprint (SHA-256):") +
    certLine(docHashHex, { after: 160 }) +
    certLine(
      "This certificate, the IP address, device, and timestamps above form the audit record of this electronic signature.",
      { italic: true, jc: "both" }
    )
  );
}

// Append the certificate before the body sectPr (so it lands last).
function appendCertificate(xml, docHashHex) {
  const sectIdx = xml.lastIndexOf("<w:sectPr");
  if (sectIdx < 0) throw new Error("no body sectPr for certificate");
  return xml.slice(0, sectIdx) + certificateBlock(docHashHex) + xml.slice(sectIdx);
}

// Tokenize an existing GP signature block + (optionally) an existing LP block.
function tokenizeExistingSignature(xml) {
  const sigIdx = xml.indexOf("SIGNATURE PAGE");
  if (sigIdx < 0) throw new Error("no SIGNATURE PAGE marker");
  const head = xml.slice(0, sigIdx);
  let region = xml.slice(sigIdx);
  const lpIdx = region.indexOf("LIMITED PARTNER");
  let gp = lpIdx >= 0 ? region.slice(0, lpIdx) : region;
  let lp = lpIdx >= 0 ? region.slice(lpIdx) : "";
  // GP: first By:/Date: blanks -> tokens
  gp = gp.replace(/(By: )_+/, "$1{{GP_SIGNATURE}}").replace(/(Date: )_+/, "$1{{GP_DATE}}");
  const lpHadBlanks = /(By: )_+/.test(lp);
  if (lpHadBlanks) {
    lp = lp
      .replace(/(By: )_+/, "$1{{LP_SIGNATURE}}")
      .replace(/(Name: )_+/, "$1{{LP_NAME}}")
      .replace(/(Date: )_+/, "$1{{LP_DATE}}");
  }
  return { xml: head + gp + lp, lpHadBlanks };
}

// Inject an LP signature block right after the counterpart note (Delaware feeder).
function injectLpBlock(xml) {
  const note = "[Counterpart signature pages maintained by the General Partner]";
  const noteIdx = xml.indexOf(note);
  if (noteIdx < 0) throw new Error("no counterpart note to anchor LP block");
  const closeIdx = xml.indexOf("</w:p>", noteIdx) + "</w:p>".length;
  const block =
    spacer(500) +
    para("By: {{LP_SIGNATURE}}") +
    para("Name: {{LP_NAME}}") +
    para("Date: {{LP_DATE}}");
  return xml.slice(0, closeIdx) + block + xml.slice(closeIdx);
}

// Append a full acknowledgement + signature page before the body sectPr.
function appendSignaturePage(xml, agreementLabel) {
  const block =
    para("ACKNOWLEDGEMENT AND SIGNATURE", { bold: true, jc: "center", before: 0, pageBreak: true }) +
    para(`IN WITNESS WHEREOF, the parties have executed this ${agreementLabel} by electronic signature as of the date set forth below.`) +
    spacer(600) +
    para("GENERAL PARTNER:", { bold: true }) +
    para("HUSHH TECHNOLOGIES MIDDLE EAST LLC", { bold: true }) +
    spacer(400) +
    para("By: {{GP_SIGNATURE}}") +
    para("Name: Manish Sainani") +
    para("Title: Founder, CEO, and Sole Managing Member") +
    para("Date: {{GP_DATE}}") +
    spacer(700) +
    para("LIMITED PARTNER:", { bold: true }) +
    spacer(300) +
    para("By: {{LP_SIGNATURE}}") +
    para("Name: {{LP_NAME}}") +
    para("Date: {{LP_DATE}}") +
    spacer(400) +
    para("Executed by electronic signature.", { italic: true });
  const sectIdx = xml.lastIndexOf("<w:sectPr");
  if (sectIdx < 0) throw new Error("no body sectPr");
  return xml.slice(0, sectIdx) + block + xml.slice(sectIdx);
}

const DOCS = [
  { key: "lp-master-lpa", filename: "LP-Master-LPA-Signed.docx", mode: "existing" },
  { key: "delaware-feeder-lpa", filename: "Delaware-Feeder-LPA-Signed.docx", mode: "existing+lp" },
  { key: "investment-prospectus", filename: "Investment-Prospectus-Signed.docx", mode: "append", label: "Prospectus" },
  { key: "ppm", filename: "Private-Placement-Memorandum-Signed.docx", mode: "append", label: "Private Placement Memorandum" },
];

const REQUIRED_TOKENS = [
  "{{GP_SIGNATURE}}", "{{GP_DATE}}", "{{LP_SIGNATURE}}", "{{LP_NAME}}", "{{LP_DATE}}",
  "{{SIG_ID}}", "{{SIG_NAME}}", "{{SIG_EMAIL}}", "{{SIG_SIGNED_UTC}}", "{{SIG_SIGNED_LOCAL}}",
  "{{SIG_IP}}", "{{SIG_DEVICE}}", "{{SIG_CONSENT}}",
];
const manifest = [];
let ok = true;

for (const doc of DOCS) {
  const bytes = new Uint8Array(readFileSync(join(SRC_DIR, `${doc.key}.docx`)));
  // SHA-256 of the exact source document version the signer is bound to.
  const docHashHex = createHash("sha256").update(bytes).digest("hex");
  const files = unzipSync(bytes);
  let xml = strFromU8(files["word/document.xml"]);

  if (doc.mode === "existing") {
    xml = tokenizeExistingSignature(xml).xml;
  } else if (doc.mode === "existing+lp") {
    const r = tokenizeExistingSignature(xml);
    xml = r.lpHadBlanks ? r.xml : injectLpBlock(r.xml);
  } else if (doc.mode === "append") {
    xml = appendSignaturePage(xml, doc.label);
  }

  // Append the Electronic Signature Certificate (per-signer tokens + baked hash).
  xml = appendCertificate(xml, docHashHex);

  // Verify every required token is present.
  for (const tok of REQUIRED_TOKENS) {
    const n = xml.split(tok).length - 1;
    if (n < 1) { console.error(`  ✗ ${doc.key}: missing token ${tok}`); ok = false; }
  }

  files["word/document.xml"] = strToU8(xml);
  const outBytes = zipSync(files);
  writeFileSync(join(OUT_DIR, `${doc.key}.docx`), outBytes);
  manifest.push({
    key: doc.key,
    filename: doc.filename,
    sha256: docHashHex,
    base64: Buffer.from(outBytes).toString("base64"),
  });
  console.log(`  ✓ ${doc.key} -> ${doc.filename} (${outBytes.length} bytes, mode=${doc.mode}, sha256=${docHashHex.slice(0, 12)}…)`);
}

const ts =
  `// AUTO-GENERATED by scripts/build-signed-doc-templates.mjs — do not edit by hand.\n` +
  `// Tokenized fund-document templates (base64 .docx) + each source document's\n` +
  `// SHA-256. The runtime signer (signFundDocs.ts) swaps GP/LP tokens + the\n` +
  `// {{SIG_*}} electronic-signature certificate tokens.\n` +
  `export interface FundDocTemplate { key: string; filename: string; sha256: string; base64: string; }\n` +
  `export const FUND_DOC_TEMPLATES: FundDocTemplate[] = ${JSON.stringify(manifest, null, 2)};\n`;
writeFileSync(
  join(ROOT, "supabase", "functions", "nda-signed-notification", "fundDocTemplates.base64.ts"),
  ts,
);
console.log(`\nWrote fundDocTemplates.base64.ts (${manifest.length} templates).`);
if (!ok) { console.error("TOKEN VERIFICATION FAILED"); process.exit(1); }
console.log("All templates tokenized and verified.");
