# Changelog

## [0.1.0] - 2026-11-24

### Added
- NestJS API with PostgreSQL (Prisma): schools, user accounts for five roles, refresh tokens and an activity log.
- Sign-in by email or Nigerian phone number with Argon2id password hashing, account lockout, per-IP rate limiting, JWT access tokens and rotating httpOnly refresh cookies with reuse detection.
- Account issuing down the chain (Ministry → schools → teachers and parents) with one-time temporary passwords and forced password change.
- Seed script for the first Ministry administrator, Docker and docker-compose setup, end-to-end tests and a CI workflow.
