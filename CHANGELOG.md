# Changelog

## [0.2.0] - 2026-11-24

### Added
- Academic sessions, classes with capacity and class teachers.
- Student enrolment with state-wide learner IDs, per-school admission numbers and duplicate detection.
- Parent and guardian links, class placement and class history, withdrawal.
- Transfers between schools (request, accept, reject, cancel); parent accounts follow their only child to the new school.
- `GET /my/classes` for teachers and `GET /my/children` for parents; student counts on `GET /stats`.
- End-to-end tests for students, classes and transfers.

## [0.1.0] - 2026-11-24

### Added
- NestJS API with PostgreSQL (Prisma): schools, user accounts for five roles, refresh tokens and an activity log.
- Sign-in by email or Nigerian phone number with Argon2id password hashing, account lockout, per-IP rate limiting, JWT access tokens and rotating httpOnly refresh cookies with reuse detection.
- Account issuing down the chain (Ministry → schools → teachers and parents) with one-time temporary passwords and forced password change.
- Seed script for the first Ministry administrator, Docker and docker-compose setup, end-to-end tests and a CI workflow.
