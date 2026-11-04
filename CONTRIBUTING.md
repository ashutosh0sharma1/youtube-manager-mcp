# Contributing to YouTube Manager MCP

Start with a small change that somebody can reproduce from a clean checkout. This is an experimental public source release; the README and VALIDATION.md describe the supported scope.

## Find the code

`src/index.ts` exposes MCP tools; OAuth, reporting and Shorts helpers live in adjacent source modules. Tests use synthetic responses.

## Useful contributions

- Add pagination and missing-data fixtures for a Reporting API edge case.
- Improve metric coverage explanations without treating unavailable values as zero.
- Improve an approval boundary in the Shorts workflow with a test proving no upload occurs before the explicit write action.

## Verify a change

Install the README dependencies, then run the relevant checks:

```sh
npm test
npm run typecheck
```

Run only checks appropriate to your change. Do not turn a unit test into a live provider call, model download, deployment or mutation of a real account. Keep optional integration acceptance explicit and report skipped prerequisites.

## Submit a pull request

Explain the observed problem, the resulting behavior, and the evidence used to verify it. Include a small synthetic reproduction for a bug. Keep unrelated formatting out of the change. Preserve upstream copyright/license notices and identify any new dependency and its license. Contributions are made under the applicable repository/source-file license.

Never include credentials, signed URLs, personal recordings, private transcripts, customer data, production exports or unlicensed media. Security reports belong in GitHub's private vulnerability reporting channel when available; do not post secrets in a public issue.
