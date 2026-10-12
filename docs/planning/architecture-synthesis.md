# Synthesis note

## Rubric

The chosen plan had to preserve two independent repositories, keep all authorization and cutoff rules in NestJS, support Phase 0 through Phase 2 without supplier scope, work locally with Docker PostgreSQL and mock PNJP data, and leave a clean seam for Enterprise SSO.

## Candidate scores

| Criterion | Candidate A | Candidate B | Result |
|---|---:|---:|---|
| Clear boundaries between web and API | 5 | 5 | Tie |
| Scope discipline for Phase 0-2 | 3 | 5 | B wins |
| Data and authorization detail | 5 | 4 | A wins |
| Small, dependency-ordered tasks | 4 | 5 | B wins |
| Avoids unnecessary architecture | 3 | 5 | B wins |

## Decision

Candidate B is the base. It treats the two repositories as an explicit REST boundary, keeps schema and operational dates simple, and breaks work into smaller units with direct completion checks.

## Grafts from Candidate A

- Refresh-token rotation behind the local identity adapter.
- A dedicated `MealSessionAccess` boundary to keep cutoff evaluation in one backend location.
- Separate reserve allocations from ordinary registrations.
- Representative bulk-entry controls, including totals by dish and an explicit confirmation for unselected employees.

## Rejected details

- `DishOption` is excluded until the menu needs configurable per-dish sub-options.
- Employee assignment history is excluded because no current Phase 0-2 user flow requires it.
- A mandatory automatic close worker is excluded. Every command evaluates cutoff itself; a status synchronizer can be added later for display consistency.
- Supplier accounts, supplier SSO, order versions, delivery, reconciliation, feedback, hosting, OCR, and production deployment remain outside Phase 0-2.
- Dedicated automated-test tasks are excluded from the implementation plan because they were not requested. Each task instead has a local, observable acceptance check.

## Verification

`implementation-plan.md` covers every decided technology, two separate repositories, Docker Compose PostgreSQL, mock PNJP data, Vietnamese time-zone handling, Phase 0, Phase 1, and Phase 2. It includes the requested JWT development mode and leaves a provider interface for future Enterprise SSO.
