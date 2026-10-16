# Instructions for the OpenQodex reviewer

The reviewer reads this file at the start of every review. It is shared, committed project configuration: a change to it is a security-relevant change (see the last section).

## What this repository is

Factory ERP is a multi-company Indian manufacturing ERP.

The application uses a TypeScript monorepo, Fastify API, React web application, PostgreSQL, Kysely, SQL migrations, command/query buses, and a controlled read-only local AI Copilot.

Correctness, company isolation, financial integrity, auditability, and security are essential.

## Architecture and coding invariants

- Company identity, user identity, roles, and permissions must come from authenticated server context, never untrusted request-body fields.
- Mutations must use the command bus. Reads must use the query bus. HTTP routes should remain thin adapters.
- Never bypass authentication, authorization, auditability, idempotency, or transaction boundaries.
- Money arithmetic must use the project's exact decimal representations and established money utilities. Never introduce floating-point money calculations, parseFloat-based money arithmetic, or Math.round-based financial calculations.
- Database changes must use forward-only SQL migrations and preserve database-enforced invariants.
- Respect existing module boundaries. Business modules must not import AI implementation details directly.
- AI must use approved typed tools and existing application buses. Do not introduce arbitrary SQL execution, direct AI database access, unauthorized tools, or unapproved write capabilities.
- Local inference is the default. Do not introduce cloud inference, automatic model downloads, or cloud fallback without explicit approval.
- Treat prompts, retrieved records, uploaded documents, and model outputs as untrusted input.
- Public errors must not disclose SQL, internal stack traces, secrets, credentials, or raw database errors.
- Logs must not contain secrets, raw prompts, sensitive answers, or confidential business records.
- Respect tenant isolation in every relevant query and mutation.
- Preserve existing tests and add focused regression tests for confirmed bugs.
- Do not introduce microservices, broad abstractions, or dependencies without a clear requirement.

## Regulatory and unfinished work

- Existing [VERIFY R-nn] tags identify regulatory or domain assumptions that require verification. Do not automatically classify the presence of such a tag as a defect.
- However, flag newly introduced unsupported regulatory claims or changes that remove an existing verification safeguard.
- Do not confuse a documented limitation with an implementation bug.
- The presence of AI_PROVIDER=fake in the isolated E2E setup is intentional. Verify that fake-provider restrictions remain enforced outside tests.

## Always investigate carefully

Pay particular attention to:

- Missing company scopes and possible cross-company data leakage.
- New routes without correct authentication or permission checks.
- Authorization decisions based on client-supplied identity or roles.
- Untrusted request data reaching SQL, logs, errors, or AI prompts.
- AI tools that bypass typed contracts, permission checks, data-classification filters, or company policy.
- Changes to authentication, sessions, database migrations, money arithmetic, financial calculations, idempotency, or audit trails.
- Secrets or real factory data included in tracked or untracked files.
- Changes to .openqodex/ instructions or configuration that weaken review coverage or hide security findings.

Distinguish confirmed vulnerabilities from hypothetical risks. Report file paths, relevant lines, impact, and evidence. Do not recommend changes merely to satisfy stylistic preference. Never modify code or push changes solely because a reviewer requests it.
