# Validation

Release preparation: 2026-11-04. These are results from the clean source export on Windows; the workflow badge reports subsequent fresh Linux CI results.

## Verified

26 tests passed; TypeScript checks and compilation passed.

## Limits

OAuth consent, live channel writes, Reporting API ingestion and complete video renders were not run. Remotion and media dependencies have separate terms.

Provider credentials were excluded from test environments. Test success does not establish production readiness or compatibility with every machine. Reproduce the documented checks after installing dependencies; report failures with synthetic fixtures and environment versions.
