<!--
  The `PR Hygiene` check parses the labelled bullets below as `- key: value`, so the text before
  the first colon has to stay exactly as written. Bolding a label — `- **what changed:**` — makes
  the key `**what changed` and the check reports the field as unfilled, which reads as a mysterious
  failure on a body that looks complete. Write values after the colon and leave the labels bare.

  `linked issue` needs an issue number, a ticket id or a URL. If there genuinely is none, say so
  with the words "none", "n/a" or "not applicable" in the sentence, or the check treats the field
  as unanswered rather than as a deliberate choice.
-->

## Summary

- what changed:
- why it changed:
- linked issue: `Fixes #123` | `Closes #123` | `internal maintainer work - reason`
- maintainer invitation: `issue has phase2:accepted + phase2:invited-pr` | `internal maintainer work - reason`
- acceptance criteria covered:
- risk area touched: `ui` | `api` | `auth` | `deploy` | `security` | `docs` | `data` | `infra` | `ci`
- reviewer focus:

## Phase 2 eligibility

- [ ] this PR fixes a maintainer-accepted Phase 2 bug report
- [ ] the linked issue is labeled `phase2:accepted`
- [ ] the linked issue is labeled `phase2:invited-pr`
- [ ] the PR body uses a closing keyword such as `Fixes #123`, `Closes #123`, or `Resolves #123`
- [ ] this is maintainer/internal work and the invitation requirement does not apply

## Validation

- [ ] commits are signed off with DCO (`git commit -s`)
- [ ] `npm run test`
- [ ] `npx tsc --noEmit`
- [ ] `npm run build:web`
- [ ] `npm run env:check`
- [ ] `npm run lint:ci`
- [ ] relevant route or smoke checks
- [ ] security checks when secrets, auth, infra, or deploy paths changed
- ran:
- did not run:
- reviewer should verify:

## Notes

- deployment impact:
- migration or env requirements:
- rollback or release notes:
- follow-up work if any:
- reviewer callouts or CODEOWNERS you expect to review this:
