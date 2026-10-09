# Factory OS — AI-Native Master Architecture

**Version:** 1.0  
**Date:** 9 October 2026  
**Status:** Strategic target architecture; implementation is incremental  
**Ambition:** Build an AI-native operating system for factories that is dramatically more useful, proactive, and easier to operate than conventional ERP software.

> **North star:** A factory owner or employee describes the outcome they need. Factory OS understands the business context, retrieves verified facts, coordinates the necessary workflows, performs permitted work, verifies the result, and brings consequential decisions or exceptions to the right person.

This document defines the intended product and technical direction. It does **not** claim that all described capabilities exist today. Existing code, migrations, tests, `docs/ARCHITECTURE.md`, and `docs/ROADMAP.md` remain authoritative for current implementation status. Reconcile this document with those files before replacing or merging existing architecture records.

---

## 1. Mission

Factory OS is not an ERP with a chatbot attached. It is an AI-native factory operating system whose reliable business engine is accessible through conversational interaction, event-driven automation, document understanding, and conventional interfaces.

The product combines:

1. **A deterministic system of record** for business entities, transactions, permissions, and history.
2. **An intelligence layer** that interprets natural language and documents, discovers context, and plans bounded work.
3. **A workflow execution layer** that invokes typed, permission-checked capabilities and verifies outcomes.
4. **A proactive operations layer** that detects important conditions, prioritises exceptions, and initiates policy-approved responses.
5. **A flexible inference layer** supporting local-first AI and, only when explicitly allowed, cloud or hybrid providers.

The goal is not merely more features. It is to reduce the time, effort, training, and coordination needed to operate a factory while preserving correctness, security, explainability, and human control.

### What “100× better” means

“100× better than Odoo” is an ambition, not a proven claim. Translate it into measurable workflow outcomes:

- elapsed time from request/document arrival to validated business outcome;
- number of manual steps and screens required;
- percentage of tasks completed without re-keying data;
- draft correction and material error rates;
- automation success, escalation, and recovery rates;
- latency and cost per completed workflow;
- user adoption and time-to-proficiency;
- quality of evidence behind answers and actions.

Odoo is a moving benchmark, not a static target. Odoo 20 announced agentic automation and natural-language creation/updating of records in September 2026. Factory OS must differentiate through end-to-end operational intelligence, trustworthy execution, local-first flexibility, factory-specific workflows, and measurable reduction in work—not merely by adding chat.

## 2. Product principles

1. **Outcome-first interaction:** Users describe what they need; they should not have to understand module boundaries.
2. **One business engine, multiple interfaces:** UI, copilot, and automation share the same domain logic and commands.
3. **Deterministic truth:** Money, tax, quantities, stock, balances, allocations, numbering, matching, valuation, and workflow state come from deterministic code and authoritative records.
4. **AI acts through typed capabilities:** No direct database access, arbitrary SQL, hidden privileged routes, or permission bypass.
5. **Risk-based human control:** Consequential, external, destructive, financial, safety-sensitive, or hard-to-reverse actions require the appropriate approval.
6. **Proactive, evidence-backed operations:** Detect meaningful events and recommend or initiate responses with links to source records.
7. **Local-first inference:** Cloud inference is disabled unless an authorised policy explicitly permits it for the task and data class.
8. **Contained failure:** Model failures must not break ordinary ERP operations.
9. **Progressive autonomy:** Start with read-only answers and drafts; increase autonomy only after evaluation and safe recovery are demonstrated.
10. **No demo theatre:** Use synthetic data while discovery is deferred. Mark assumptions and regulatory decisions for later validation.

## 3. User experience model

Factory OS has three complementary modes.

### 3.1 Conventional interface
Searchable tables, forms, detail pages, reports, dashboards, and role-specific views remain essential for review, comparison, evidence inspection, and approvals. Interfaces should be fast, keyboard-friendly, responsive, and easy for factory staff to learn.

### 3.2 Conversational interface
Users can ask questions or describe tasks, for example:
- “Show me overdue supplier invoices and explain why they are overdue.”
- “Why are these production orders delayed?”
- “Read this supplier invoice and prepare a draft.”
- “Find the raw-material shortage affecting next week’s orders.”
- “Prepare a purchase-order draft, but do not submit it.”

Answers must be grounded in authorised query results. The assistant must identify uncertainty and missing data, link to source records, and never claim an action succeeded until the command and postcondition verification succeed.

### 3.3 Event-driven automation
Eventually, Factory OS should react to stock thresholds, overdue deliveries, incoming documents, blocked production orders, invoice mismatches, machine breakdowns, and customer commitments at risk. Every automation needs a trigger, policy, allowed tools, limits, owner, escalation path, and audit trail. A trigger does not grant unlimited authority.

## 4. Target architecture

```text
People / Devices / Inputs
 Web UI · Copilot · Voice · Documents · Integrations
                         |
                 Authenticated API
                         |
          +--------------+---------------+
          |                              |
  Conversational Runtime         Event / Workflow Engine
  bounded plan-and-act loop      triggers, schedules, policies
          |                              |
          +--------------+---------------+
                         |
               AI Gateway / Policy
     provider routing · data policy · budgets · telemetry
                         |
           local inference by default
      optional cloud/hybrid only by explicit policy
                         |
                  Typed Tool Registry
          permission-filtered queries and commands
                         |
              +----------+----------+
              |                     |
          Query Bus             Command Bus
              |                     |
              +----------+----------+
                         |
                Domain Modules
 sales · purchasing · inventory · production · quality
 people · maintenance · finance · documents · tasks
                         |
             PostgreSQL / Source of Truth
 constraints · transactions · ledgers · audit · outbox
                         |
              Verified results and evidence
```

This is a logical architecture, not a mandate to split the application into services. Keep the modular monolith until a measured requirement justifies otherwise.

## 5. System of record and domain architecture

### 5.1 Authoritative writer
The factory server is the authoritative writer for operational state. Do not introduce multi-master synchronisation. LAN and remote access must reach the same authoritative application/database. Preserve the current single-origin application topology unless an explicit architecture decision changes it.

### 5.2 Modular monolith
Maintain clear module ownership and public interfaces. Expected domains over time include:

- identity, companies, permissions, configuration;
- parties and master data;
- sales, customer orders, invoicing, dispatch;
- purchasing, supplier bills, payments;
- inventory, warehouses, movements, replenishment, traceability;
- manufacturing, BoMs, work orders, shop floor;
- quality, non-conformance, corrective actions;
- machines, maintenance, downtime;
- workforce, shifts, skills, attendance, task allocation;
- finance, receivables, payables, costing, accounting exports;
- documents, OCR, evidence, templates;
- tasks, notifications, internal communication;
- analytics and reporting;
- AI gateway, conversations, tools, proposals, policy, usage;
- automation triggers, execution history, escalations.

These are target domains, not a demand to create empty modules. Implement them incrementally.

### 5.3 Ownership and invariants
Each table has one owning module. Cross-module operations use public domain APIs, typed commands/queries, or explicit integration contracts. Do not write directly into another module’s tables.

Preserve and extend existing guarantees:
- PostgreSQL is the source of truth.
- Migrations are forward-only and reviewed.
- Database constraints enforce important invariants.
- Financial/stock history is append-only or corrected by explicit compensating entries.
- Balances are derived from authoritative records and ledgers.
- Commands validate, authorise, transact, audit, and enforce idempotency.
- Side effects use the transactional outbox.
- Concurrency-sensitive workflows use locks and database constraints.
- Company isolation is enforced server-side and tested adversarially.
- Money and quantities use exact decimal types and explicit rounding rules.

LLMs must never authoritatively calculate or set tax totals, financial totals, balances, stock-on-hand, allocations, numbering, match results, valuation, or other deterministic business facts.

## 6. AI intelligence layer

### 6.1 AI Gateway
The gateway is the only application boundary for model inference. It owns:
- provider/model adapters and capability declarations;
- policy-based routing and data-classification enforcement;
- locality restrictions;
- timeouts, cancellation, retry rules, and concurrency limits;
- input/output budgets and task limits;
- structured-output validation;
- provider health and availability;
- usage, latency, outcome, and error telemetry;
- safe failure and fallback rules.

Business modules must not import provider SDKs or call Ollama/cloud APIs directly.

### 6.2 Provider abstraction
Business workflows depend on provider-neutral interfaces, not vendor-specific SDKs or model names. Start with text generation and structured output required by the copilot. Add vision, embeddings, or other capabilities only when a real workflow requires them.

### 6.3 Deterministic routing
Routing inputs should include task/capability, data class, company policy, allowed locality, provider health, model capability, latency/cost constraints, deadline, and request budget.

Required invariants:
1. Local-only requests never use cloud inference.
2. Cloud inference is disabled unless policy explicitly permits it.
3. Restricted data never reaches an unauthorised provider.
4. Unavailable or incompatible models are never selected.
5. Fallback preserves all original restrictions.
6. Missing or invalid policy fails closed.
7. Routing is deterministic for identical inputs.
8. Locality never changes silently.
9. Telemetry reports the route actually used.
10. If no safe model is available, return a clear unavailable result.

### 6.4 Local runtime and future providers
Ollama is the initial local adapter. Do not assume it is installed, running, or has a model downloaded. Do not automatically download models. Test the adapter through a fake HTTP server in CI. If local inference is unavailable, ordinary ERP operations continue and the copilot reports unavailability; it must not silently fall back to cloud.

Cloud adapters are future extensions behind the same gateway. They require explicit configuration, secret management, data-policy checks, telemetry, and leakage tests. Model choice should eventually be hardware-adaptive based on measured task quality, latency, and resource use—not assumptions about model capability.

## 7. Typed tools and safe execution

### 7.1 Tool registry
Derive tools from approved command/query definitions, not a second business API. Each tool has a stable name, description, schema, owning domain, data class, AI tier, required permissions, side-effect definition, limits, and tests. Expose only tools needed for a workflow; do not automatically expose every command.

### 7.2 Risk tiers
Use the existing model:
- **READ:** permitted read-only queries.
- **DRAFT:** create/update a safe persisted draft when the authenticated user has permission.
- **CONFIRM:** persist a proposal; an authorised human must confirm through a normal application route.
- **FORBIDDEN:** never exposed to AI.

AI runs as the authenticated user with an explicit AI actor/session in audit. It cannot elevate privileges, impersonate another user, or trust model-supplied company/user IDs. Some data, such as bank credentials, may be AI-forbidden even when accessible to a human.

### 7.3 Persisted proposals
A proposal is a typed persisted record, not text in a chat. Capture validated arguments, source record IDs/versions, rationale, expected impact, company/user/conversation, required permission, expiry, state, and execution result.

On confirmation, re-check identity, company scope, permission, policy, current state, and all business invariants. Reject stale proposals. Execute via the ordinary command bus and idempotency controls. AI cannot approve its own proposal. Clearly distinguish “proposed” from “executed” in the UI.

### 7.4 Bounded runtime
Hard-limit wall-clock time, model calls, tool calls, loop iterations, context size, tokens where measurable, concurrency, proposal count, retries, and output size. No unbounded agent loops or orchestration framework without a concrete, measured need.

## 8. Context, grounding, and memory

- Context is assembled through permission-checked queries and approved documents; the server decides what the model may see.
- Factual answers use records and deterministic calculations, link sources, distinguish facts from hypotheses, and admit when evidence is insufficient.
- Persist conversation/tool activity only as needed. Define retention. Avoid storing full prompts/responses by default when metadata and references suffice.
- Never place passwords, session cookies, secrets, full bank account numbers, or unnecessary personal data in prompts or telemetry.
- Do not introduce vector databases or autonomous long-term agent memory in the first copilot slice. Add retrieval only for a concrete use case with permissions, freshness, provenance, and deletion rules. Model memory is never the system of record.

## 9. Proactive automation and orchestration

Use the transactional outbox and domain events as the foundation. Event delivery may be at least once; handlers must be idempotent.

Each automation defines its trigger, eligible scope, conditions, data policy, allowed tools, approval rules, budgets, retries, owner, escalation, deduplication key, execution history, and kill switch.

Progress through autonomy levels:
- **0 Observe:** detect and report.
- **1 Recommend:** investigate and explain.
- **2 Prepare:** create a draft/proposal.
- **3 Approved execution:** human authorises the specific action.
- **4 Policy-bounded automation:** automatically execute a narrow, low-risk action under explicit rules.
- **5 Cross-workflow orchestration:** coordinate domains while gating consequential actions.

Increase autonomy only after evaluations demonstrate reliability and safe recovery. Prioritise exceptions by urgency, impact, evidence, confidence, and deadline. Show affected records, evidence, recommended next steps, owner, status, and resolution history.

## 10. Document and multimodal intelligence

Document processing is a workflow, not merely OCR:

1. Receive file/photo/email through a supported input.
2. Validate type, size, content risks, and company scope.
3. Store securely with content hash and provenance.
4. Extract text/layout with OCR or parsers.
5. Extract fields into a validated schema.
6. Normalise dates, units, parties, and identifiers.
7. Match against authoritative master data and transactions.
8. Run deterministic domain checks and discrepancy calculations.
9. Prepare a draft or exception; do not silently post a consequential transaction.
10. Preserve source-to-field provenance and reviewer corrections.
11. Measure accuracy, failure modes, latency, and cost.

Start with high-value documents such as supplier invoices and purchase documents. Cloud processing requires explicit policy permission. Use synthetic fixtures until real-world samples are authorised.

## 11. Cross-domain factory intelligence

Factory OS should connect operational relationships explicitly, for example:

- customer order → production demand → BoM → material requirement → stock shortage → purchase order → supplier delivery → goods receipt;
- work order → machine → downtime → maintenance request → delayed production;
- goods receipt → quality inspection → rejected lot → supplier exception;
- customer commitment → production progress → dispatch readiness → invoice/receivable;
- supplier invoice → purchase order and receipt → matching discrepancy → approval/payment.

Represent these relationships through domain links, event history, and read models. Do not rely solely on an LLM to infer them from free text. The AI should investigate the graph through typed queries and explain its evidence.

## 12. Security and governance

Security is enforced in code, not merely in prompts. Required controls:
- authentication and RBAC on every endpoint and tool;
- company scope from trusted session context;
- data classification on every query/document path;
- allowlisted tools and provider routes;
- secret redaction;
- explicit cloud-data policy;
- no direct model-to-database access or arbitrary SQL;
- strict output validation;
- safe file parsing and upload limits;
- prompt-injection threat modelling for documents, email, OCR, and retrieved content;
- human approval for consequential actions;
- idempotency, audit, and replay-safe execution;
- per-user/company/task rate limits and budgets;
- kill switches for AI, providers, and automations;
- retention rules for conversations, documents, and telemetry;
- tests for cross-company leakage, privilege escalation, malicious arguments, and stale proposals.

Prompt injection cannot be eliminated by a system prompt. Treat user input, documents, and retrieved content as untrusted data. Enforce permissions and action limits outside the model.

## 13. Observability and evaluation

Record redacted telemetry sufficient to understand what happened:
- company, user, conversation, task, and trace IDs;
- provider/model and actual locality;
- data class and routing decision;
- tool calls and validated outcomes;
- token counts only when reliably reported;
- latency, timeout, retry, cancellation, and error;
- proposal/confirmation outcomes;
- cost only when a valid price source/configuration exists;
- fallback reason and policy checks;
- evaluation version and workflow outcome.

Never fabricate tokens, costs, confidence, or capability. Maintain synthetic-data evaluations for grounded accuracy, tool choice, argument validity, policy adherence, harmful-action refusal, latency, cost, and robustness. Include ambiguous requests, missing data, stale proposals, injection, outages, and partial failures. CI uses deterministic fake providers; live model smoke tests are optional.

## 14. Deployment and resilience

Factory V1 keeps the local factory server authoritative and serves the web app from the same origin. Core LAN workflows should not require internet. AI availability is separate from ERP availability. Local model runtime is optional infrastructure.

Test behaviour when the model, database, network, outbox, parser, provider, remote-access path, or automation is unavailable. Core ERP writes must not depend on successful model inference unless the operation specifically requires AI extraction, in which case it remains a draft until validated.

SaaS, central control plane, multi-region hosting, and distributed services are later decisions. Do not prematurely build a SaaS control plane into Factory V1.

## 15. Engineering rules

1. Preserve the TypeScript-first modular monolith.
2. Use Python for specialist OCR, vision, or optimisation sidecars only when justified.
3. Reuse existing command/query buses, contracts, permissions, audit, idempotency, outbox, and data classifications.
4. No direct database access from AI code.
5. No provider SDK calls from business modules.
6. No LLM financial or inventory arithmetic.
7. Do not weaken tests to obtain a green build.
8. No hidden cloud fallback.
9. No consequential automation without explicit policy and required approvals.
10. No new infrastructure or dependency without a concrete requirement.
11. Use synthetic data while discovery is deferred.
12. Update roadmap and architecture records as decisions change.
13. Commit coherent, tested increments locally; do not push unless explicitly requested.
14. Do not add AI attribution to commit messages.
15. Stop after the requested slice and report evidence, limitations, and next step.

## 16. Implementation strategy

### Current baseline (9 October 2026)
The project has a modular TypeScript monolith with PostgreSQL, authentication/RBAC, typed command/query buses, audit, idempotency, outbox, deterministic financial logic, sales invoicing/receivables, and a procurement/inventory/supplier-payables vertical slice. AI architecture seams and risk tiers exist; the complete copilot is not yet implemented. Code and current CI results are authoritative for exact status.

### Next: AI Gateway + Factory Copilot v0
Build:
- provider-neutral gateway and deterministic policy routing;
- local Ollama adapter with fake-provider tests;
- fail-closed locality and data-class policies;
- typed, permission-filtered query and draft tools;
- bounded conversational runtime;
- persisted conversations, tool activity, and action proposals;
- human confirmation through normal application routes;
- integrated copilot UI;
- redacted usage/latency/outcome telemetry;
- isolation, injection, outage, security, and browser E2E tests.

Do not implement cloud inference in this slice. Do not build vector memory or an elaborate agent framework. The first end-to-end acceptance scenario should query synthetic ERP records, explain results with evidence, persist a draft, and leave consequential execution to an authorised human.

### Then
1. **Document intelligence:** intake, extraction, provenance, schema validation, deterministic matching, exceptions, and draft preparation.
2. **Cross-domain workflows:** connect sales demand, purchasing, inventory, production, and dispatch through complete end-to-end journeys.
3. **Proactive automation:** event-driven, bounded, observable workflows with escalation and policy-controlled autonomy.
4. **Production intelligence:** scheduling, workforce allocation, quality, maintenance, costing, and analytics as reliable underlying workflows/data mature.

The exact order may be adjusted through `docs/ROADMAP.md`, but changes must preserve the north star and architectural invariants.

## 17. Definition of done for any AI feature

A feature is not complete because a model gives a plausible answer. It is complete only when the user problem is explicit; schemas and data class are defined; access is enforced server-side; facts are grounded; deterministic calculations remain deterministic; output is validated; writes are persisted and reviewable; execution uses ordinary commands; stale state and failures are handled; audit/telemetry exist; routing follows policy; adversarial tests pass; UI shows evidence and status; and the workflow is evaluated against a baseline.

## 18. Open decisions

Record material architecture decisions as ADRs; do not silently turn open questions into assumptions. Open areas include automation policy language/admin UX, AI conversation retention, autonomy evaluation thresholds, local-model benchmarks, document ingestion channels, notifications/escalations, operator-device offline behaviour, future SaaS boundaries, and statutory accounting/tax decisions requiring authoritative validation.

Factory discovery remains deferred while this is a synthetic-data prototype. Do not block current engineering on factory visits, Tally exports, real bank information, or CA input. Mark regulatory/accounting decisions for later validation and retain specimen/demo protections.

## 19. Final architectural statement

- **The system of record** knows what is true.
- **Deterministic domain logic** calculates what must be exact.
- **AI** interprets, investigates, explains, and proposes.
- **Typed tools and workflows** let AI interact with the business safely.
- **Policy and people** determine what may happen automatically.
- **Audit and evaluation** prove what happened and whether it worked.

The intended result is software people can operate by describing outcomes, that helps coordinate the factory proactively, and that automates real work without sacrificing ERP-grade reliability.
