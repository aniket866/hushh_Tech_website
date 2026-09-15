import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const contractPath = path.join(root, "scripts", "ci", "env-contract.json");
const exampleEnvPath = path.join(root, ".env.local.example");
const typedEnvPath = path.join(root, "src", "vite-env.d.ts");
const reportPath =
  process.env.ENV_CONTRACT_REPORT_PATH || path.join(root, "tmp", "ci", "env-contract-report.json");

const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const exampleEnv = fs.readFileSync(exampleEnvPath, "utf8");
const typedEnv = fs.readFileSync(typedEnvPath, "utf8");
const errors = [];

fs.mkdirSync(path.dirname(reportPath), { recursive: true });

const typedVars = [...typedEnv.matchAll(/readonly\s+([A-Z][A-Z0-9_]+)\??:\s+string;/g)].map(
  ([, name]) => name
);
const exampleVars = [...exampleEnv.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map(([, name]) => name);
const typedSet = new Set(typedVars);
const exampleSet = new Set(exampleVars);
const contractClientSet = new Set([...contract.clientRequired, ...contract.clientOptional]);

for (const name of contract.clientRequired) {
  if (!typedSet.has(name)) {
    errors.push(`Typed client env is missing required key ${name}.`);
  }
  if (!exampleSet.has(name)) {
    errors.push(`.env.local.example is missing required client key ${name}.`);
  }
}

for (const name of contract.clientOptional) {
  if (!typedSet.has(name)) {
    errors.push(`Typed client env is missing optional key ${name}.`);
  }
  if (!exampleSet.has(name)) {
    errors.push(`.env.local.example is missing optional client key ${name}.`);
  }
}

for (const name of typedVars) {
  if (!contractClientSet.has(name)) {
    errors.push(`src/vite-env.d.ts contains ${name}, but env-contract.json does not track it.`);
  }
}

for (const name of contract.documentedServerVars) {
  if (!exampleSet.has(name)) {
    errors.push(`.env.local.example is missing documented server key ${name}.`);
  }
}

for (const [name, files] of Object.entries(contract.criticalServerRouteVars)) {
  for (const relativeFile of files) {
    const filePath = path.join(root, relativeFile);
    const contents = fs.readFileSync(filePath, "utf8");
    const supportedPatterns = [
      `process.env.${name}`,
      `env.${name}`,
      `env["${name}"]`,
      `env['${name}']`,
    ];
    const hasReference = supportedPatterns.some((pattern) => contents.includes(pattern));
    if (!hasReference) {
      errors.push(
        `${relativeFile} no longer references ${name} through an approved env access path; update env contract.`
      );
    }
  }
}

for (const workflowFile of contract.buildWorkflowFiles) {
  const contents = fs.readFileSync(path.join(root, workflowFile), "utf8");
  for (const name of contract.clientRequired) {
    if (!contents.includes(name)) {
      errors.push(`${workflowFile} does not reference required build env ${name}.`);
    }
  }
}

for (const workflowFile of contract.deployWorkflowFiles) {
  const contents = fs.readFileSync(path.join(root, workflowFile), "utf8");
  for (const name of contract.deployRuntimeRequired) {
    if (!contents.includes(name)) {
      errors.push(`${workflowFile} does not reference required runtime env ${name}.`);
    }
  }
}

for (const workflowFile of contract.policyWorkflowFiles) {
  const contents = fs.readFileSync(path.join(root, workflowFile), "utf8");
  for (const name of contract.forbiddenProductionBrowserSecrets) {
    if (contents.includes(name)) {
      errors.push(`${workflowFile} references forbidden production browser secret ${name}.`);
    }
  }

  for (const [name, expectedValue] of Object.entries(contract.unsafeBooleanFlags)) {
    const allowTruePattern = new RegExp(`${name}[=:][^\\n]*true`, "i");
    if (allowTruePattern.test(contents)) {
      errors.push(`${workflowFile} enables unsafe flag ${name}=true.`);
    }

    if (
      workflowFile.endsWith("ci.yml") ||
      workflowFile.endsWith("main-post-merge-smoke.yml")
    ) {
      const explicitValuePattern = new RegExp(`${name}[" :]+${expectedValue}`, "i");
      if (!explicitValuePattern.test(contents)) {
        errors.push(`${workflowFile} must set ${name}=${expectedValue} explicitly.`);
      }
    }
  }
}

const uatWorkflow = fs.readFileSync(
  path.join(root, ".github", "workflows", "deploy-uat.yml"),
  "utf8"
);
const productionWorkflow = fs.readFileSync(
  path.join(root, ".github", "workflows", "deploy-prod.yml"),
  "utf8"
);

for (const [name, secretName] of Object.entries(contract.uatOnlyRuntimeSecrets ?? {})) {
  if (!uatWorkflow.includes(`${name}=${secretName}:latest`)) {
    errors.push(`deploy-uat.yml must bind ${name} to ${secretName}:latest.`);
  }
  if (productionWorkflow.includes(`${name}=`) || productionWorkflow.includes(secretName)) {
    errors.push(`deploy-prod.yml must not bind UAT-only Research credential ${name}.`);
  }
}

/*
 * Secrets the UAT runtime needs bound, without claiming anything about production.
 *
 * `--set-secrets` REPLACES the whole set rather than merging into it, so a binding left off that
 * line is removed by the very next deploy — and nothing fails. The revision comes up healthy and
 * the endpoints that need the secret answer 503 forever. That is exactly how the public
 * rate-limit salt was lost: bound out-of-band, stripped by each deploy, and invisible because the
 * neighbouring `--update-env-vars` MERGES, so the feature flag beside it survived every time.
 *
 * Kept separate from uatOnlyRuntimeSecrets, which additionally asserts production must never bind
 * the name. True of the Research credentials; not true here. Production will want this binding the
 * day its public market surface is switched on.
 */
for (const [name, secretName] of Object.entries(contract.uatRuntimeSecrets ?? {})) {
  if (!uatWorkflow.includes(`${name}=${secretName}:latest`)) {
    errors.push(
      `deploy-uat.yml must bind ${name} to ${secretName}:latest — --set-secrets replaces the ` +
        "whole set, so an unlisted binding is dropped on the next deploy.",
    );
  }
}

for (const [name, expectedValue] of Object.entries(contract.uatResearchRuntimeValues ?? {})) {
  if (!uatWorkflow.includes(`${name}: ${expectedValue}`)) {
    errors.push(`deploy-uat.yml must pin ${name} to ${expectedValue}.`);
  }
  const runtimeBinding = name + "=${" + name + "}";
  if (!uatWorkflow.includes(runtimeBinding)) {
    errors.push(`deploy-uat.yml must propagate ${name} into the Cloud Run runtime env.`);
  }
}

for (const name of contract.productionForbiddenRuntimeVars ?? []) {
  if (productionWorkflow.includes(`${name}=`) && name !== "HUSHH_RESEARCH_CLIENT_ENABLED") {
    errors.push(`deploy-prod.yml must not set UAT-only Research runtime variable ${name}.`);
  }
}

if (!productionWorkflow.includes('HUSHH_RESEARCH_CLIENT_ENABLED: "false"')) {
  errors.push("deploy-prod.yml must hard-disable the Research client at workflow scope.");
}
if (!productionWorkflow.includes("HUSHH_RESEARCH_CLIENT_ENABLED=false")) {
  errors.push("deploy-prod.yml must hard-disable the Research client in Cloud Run runtime env.");
}
if (
  !productionWorkflow.includes("Refuse drifted Research bindings in production") ||
  !productionWorkflow.includes('startswith("HUSHH_RESEARCH_")')
) {
  errors.push("deploy-prod.yml must fail closed when Research production bindings drift.");
}

fs.writeFileSync(
  reportPath,
  JSON.stringify(
    {
      typedVars,
      exampleVars,
      errors,
      valid: errors.length === 0
    },
    null,
    2
  )
);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}
