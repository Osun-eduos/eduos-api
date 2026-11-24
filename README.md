# eduos-api

**Application API, database and sync service for Osun EduOS.**

Part of [Osun EduOS](https://github.com/Osun-eduos/osun-eduos), the open-source education management and intelligence system for Osun State.

> **Status: planned.** No code yet. This repository sets out the scope so contributors can discuss the design before building. See the [architecture document](https://github.com/Osun-eduos/osun-eduos/blob/main/docs/architecture.md).

## Responsibilities

- **Identity and access**: sign-in through OpenID Connect; roles for teacher, school admin, principal, LGA officer, Ministry officer, inspector and parent; scope by school and LGA.
- **Registries**: schools, sessions and terms, students and enrolments, teachers and postings.
- **Assessment**: exam setup, score capture, grading scales, results approval workflow (draft → submitted → approved → sent to Ministry), report card data.
- **Operations**: attendance, transfers, inspections, announcements.
- **Sync service**: idempotent endpoints that accept queued events from the offline mobile app and return conflicts.
- **Notifications**: SMS and push through a pluggable gateway.
- **Audit log**: who changed which record, and when.
- **Reporting feed**: data for Ministry dashboards and development indicators.

## Proposed stack

| Concern | Proposal |
| --- | --- |
| Language and framework | TypeScript with NestJS, or Python with Django (to be decided) |
| Database | PostgreSQL 16 with PostGIS, row-level security |
| API style | REST/JSON with a published OpenAPI specification |
| Auth | Keycloak (OpenID Connect) |
| Jobs | Queue for SMS, report generation and sync processing |
| Packaging | Docker images; deployable on state or Nigerian cloud infrastructure |

## First milestones

1. Agree the data model and OpenAPI outline (issue in [osun-eduos](https://github.com/Osun-eduos/osun-eduos)).
2. Scaffold the service with auth, schools, sessions and terms.
3. Students, enrolment and class allocation.
4. Score entry, grading and the approval workflow.
5. Sync endpoints for the [Android](https://github.com/Osun-eduos/eduos-android) and [iOS](https://github.com/Osun-eduos/eduos-ios) apps.

## Privacy

This service will hold records about children. Design for the Nigeria Data Protection Act 2023 from the start: minimise data, encrypt at rest and in transit, restrict by role and scope, and log access. Never commit real personal data, including in tests and fixtures.

## Contributing

See the organisation-wide [contributing guide](https://github.com/Osun-eduos/.github/blob/main/CONTRIBUTING.md).

## Licence

[GNU Affero General Public License v3.0](LICENSE).
