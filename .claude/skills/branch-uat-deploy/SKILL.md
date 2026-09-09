---
name: branch-uat-deploy
description: >-
  Use when a branch — not a green `main` — has to run on UAT, or when GitHub
  Actions is unavailable, blocked, or too slow, and the deploy must go through
  the Cloud Build and Cloud Run REST APIs directly. Trigger on "deploy this
  branch to UAT", "deploy without Actions", "no gcloud in this container", a
  Cloud Run revision that came up missing env vars or secrets, or any request to
  verify what a deployed host is actually serving. The companion to the `deploy`
  skill, which covers the normal green-main path through Actions.
---

# Deploying a branch to UAT without gcloud or Actions

`.github/workflows/deploy-uat.yml` only ever ships a green `main`. That is the
right gate for a release and the wrong one for validating a branch. This is the
branch path.

```bash
GCP_DEPLOY_SA_KEY_B64=<base64 key> npm run deploy:uat
npm run verify:deployment
```

There is no `gcloud` in this container and no Cloud Build trigger on
`hushh-tech-uat`, so everything runs against the REST APIs:
Cloud Build v1 for the build, Cloud Run Admin v2 for the deploy, GCS JSON for
the source archive. `scripts/deploy/gcp-auth.mjs` mints the token and is shared
by every GCP script in the repo.

## The rule that makes this safe

**Deploy is a read-modify-write, never a re-declare.**

`GET` the service, change exactly three things — `template.containers[0].image`,
the `DEPLOY_COMMIT_SHA` env value, and the revision labels — then `PATCH`. The
script asserts the env var and secret counts are unchanged afterwards and fails
the deploy if they moved.

This is not defensive habit. `cloudbuild-uat.yaml` deploys with
`--set-env-vars` / `--set-secrets`, which are **replace, not merge**. The live
revision carries 30 plain env vars and 18 secret-backed ones — Cloud SQL wiring,
the Firebase project, the Research client, GA4, Search Console. That file names
five and eleven. Running it drops two thirds of the service's configuration and
the app comes up looking almost fine.

That file is now inert and carries a comment pointing here. Do not resurrect it.

## A Dockerfile COPY is not enough on its own

`deploy-prod.yml` ships with `gcloud run deploy --source .`, which uploads a
build context filtered by `.gcloudignore` and only then runs Docker. So a path
the Dockerfile copies but `.gcloudignore` excludes fails **at deploy time inside
Cloud Build**, not at review time.

`.gcloudignore` excludes `*.md` wholesale, which silently swallowed
`content/decks/text/` — the committed deck bodies the runtime falls back to.
Re-including needs a negation (`!content/decks/text/**/*.md`), and a negation
cannot rescue a file whose *parent directory* is excluded: narrow `dir/` to
`dir/*` first, then negate.

`scripts/ci/check-deploy-build-context.mjs` is the gate for this, and it
**skips silently without gcloud** — so a green local run proves nothing. To check
it without gcloud, lean on git, which implements the same ignore semantics:

```bash
mkdir /tmp/ctx && cd /tmp/ctx && git init -q .
cp /path/to/repo/.gcloudignore .gitignore
mkdir -p content/decks/text && touch content/decks/text/x.md
git check-ignore -v content/decks/text/x.md   # no output means it survives
```

## Other invariants

- **The archive is `git archive`, and it refuses a dirty tree.** What deploys is
  what is committed — no accidental local file rides along, and the deployed
  `DEPLOY_COMMIT_SHA` is meaningful.
- **Build-time `VITE_*` secrets never enter the session or the build log.** They
  travel Secret Manager → Cloud Build `availableSecrets`/`secretEnv` → docker
  build arg. `Dockerfile.gcp` greps the built bundle for
  `identitytoolkit.googleapis.com` and fails the image build if they were
  missing, so a broken login page cannot ship silently.
- **Revision names are `<service>-<stamp>-<sha8>`.** Cloud Run rejects a revision
  name that sorts before the current one, so the stamp leads.
- **Traffic is already `LATEST`.** A new revision takes 100 % on its own; there
  is no traffic-shifting step to forget.
- **Rollback** is the same PATCH with the previous image digest, which the script
  captures before it writes.

## Verifying, which is the part people skip

`npm run verify:deployment` checks what a user and a crawler actually get, not
what the artefacts claim. It exists because two defects on this branch were
invisible to every artefact check: a document head identical on every URL, and a
Firestore list silently truncated to its first page. Both were obvious the
moment anyone looked at a response.

```bash
node scripts/deploy/verify-deployment.mjs                                # UAT
node scripts/deploy/verify-deployment.mjs --expect-commit <sha>          # pin the revision
node scripts/deploy/verify-deployment.mjs --host https://hushhtech.com   # after a promotion
```

It exits non-zero on the first failed expectation, so it works as a gate. Add
`node scripts/community/verify-sensitive-nda-gate.mjs --host <host>` — the NDA
gate is checked against the deployed host, not against source.

## Credentials and blast radius

`GCP_DEPLOY_SA_KEY_B64` resolves to
`claude-code-gcp-operator@hussh-developer-platform`.

**Do not assume the credential is your safety net.** It reads
`hushh-tech-uat` *and* `hushh-tech-prod` — production — successfully. The project
that returns 403 is `hushh-tech`, which is a **different project entirely** and is
not where this site runs. Anyone who reads "403 on prod" from an old note and
relaxes is reading about the wrong project.

What actually confines this path is the code: `PROJECT` is a hardcoded constant
in `scripts/deploy/uat-deploy.mjs`, along with the service name and the source
bucket. There is no flag, env var or argument that retargets it. Keep it that
way — it is the only real guard here.

Promoting to production goes through the `deploy` skill: a green `main` SHA,
`deploy-prod.yml`, and the GitHub deployment-environment approval on it. Those
three gates are the reason a branch cannot reach prod, and going around them with
a REST call is bypassing a review gate, not taking a shortcut.
