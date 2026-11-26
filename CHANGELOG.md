# Changelog

## [0.9.0] - 2026-11-26

Everything in the original prototype is now in the product.

### Added
- School profiles: town, year established, GPS location, classrooms, expected enrolment and facilities. Schools keep their own profile; the list shows each school's latest inspection or "pending inspection".
- Results: a due date per term, closing score entry for a term, each school's submission status with the latest releases, approving every waiting score sheet at once, and a class and subject analysis (grade spread, arms compared, ranking).
- Grading scales the Ministry can change (`GET/PUT/DELETE /grading`), used everywhere grades appear.
- Report cards show the overall grade, promotion at the end of the year and a verification code; anyone can check a code at `GET /verify/:code` without signing in.
- Sessions can be created with their three terms; the Ministry can tell every parent when a term begins, in the app and by text.
- Exam timetables per school, class level and term, which parents can see.
- Enrolment records the previous school and entry class, and texts the guardian the admission number. New students can be auto-allocated to arms, balancing size and sex.
- Notices to staff as well as parents; parents can list their schools' notices.
- Staff register with clock-in for teachers, training hours against a 40-hour target, and subject shortages at one teacher per 40 pupils.
- Infrastructure: minimum standards by LGA, classroom shortfall, and follow-up on inspection reports (urgent, planned, resolved).
- Indicators: population estimates per LGA, gross and net enrolment ratios, out-of-school estimates, transition and completion, pupils per classroom, up to three LGAs compared over six terms, and a dashboard overview with LGA status and the schools that most need support.

## [0.8.0] - 2026-11-26

### Added
- Education indicators for the state, each LGA and each school, for any session or term, with trends across sessions and attendance by month. Exports as CSV, Excel (built without third-party spreadsheet libraries) and a printable PDF report.
- Notifications: an inbox for everyone, with absences, released report cards, accepted transfers and school notices. Report card texts with a school setting. School notices to all parents or one class, optionally by text. Push notifications through Firebase Cloud Messaging when `FIREBASE_SERVICE_ACCOUNT` is set.
- Archive: the class list takes a `sessionId`, so past sessions can be browsed; tests confirm closed sessions cannot be changed.

### Fixed
- A malformed `sessionId` or `schoolId` on the class list now gets a clear 400 instead of a server error.

## [0.7.0] - 2026-11-26

### Added
- Absence texts to parents through KudiSMS: queued when a register is saved, sent after a short delay unless the register is corrected, once per child, parent and day. Background sender with retries, a school on/off setting, a message log and a Ministry test send. Texts are only logged until the KudiSMS token and sender ID are set.
- Staff registry: staff records with or without accounts, qualifications, training, posting history, school transfer requests approved by the Ministry, and direct Ministry postings that move a linked account. Staff counts and pupils per teacher on the home screens.
- Infrastructure inspections: a versioned checklist, an overall grade with the issues behind it, idempotent uploads of visits and photos from the mobile app, S3-compatible photo storage, and read access for the school, its LGA and the Ministry.
- `render.yaml` and `.env.example` list the new KudiSMS and S3 settings.

## [0.6.0] - 2026-11-25

### Added
- LGA education officer and school inspector roles. Both are read only and see only their LGA; an inspector without an LGA covers the state. Only the Ministry administrator creates them. Changing an officer's LGA signs them out.
- Holidays set by the Ministry (`/holidays`), with a helper that adds the federal holidays for a session. Registers are refused on holidays, and the day view, home counts and a teacher's classes say which holiday it is.
- Spreadsheet import of students (`POST /students/import`) with a dry run, per-row checks, class placement, parent linking by phone or email, and one-time parent passwords.

### Changed
- JSON request bodies may be up to 1 MB, for imports.

## [0.5.1] - 2026-11-25

### Added
- `render.yaml` Blueprint for a pilot on Render: database, API, sync service and web app.
- The container creates the first Ministry administrator on start when `SEED_ADMIN_*` values are set and none exists yet.

### Fixed
- The production image now includes the Prisma CLI, so migrations on start use the pinned version instead of downloading one.

## [0.5.0] - 2026-11-25

### Added
- Sign-in for native apps: with `X-Client: mobile`, login, refresh and logout exchange the refresh token in the request and response body instead of a cookie.
- `SyncEvent` table, written by [eduos-sync](https://github.com/Osun-eduos/eduos-sync) to apply each change from a phone once.
- `GET /subjects` without a level returns the whole subject list.

## [0.4.1] - 2026-11-25

### Added
- Per-term choice of senior secondary grading: the WAEC scale (A1 to F9, default) or A to F. It cannot change once that term's SSS results are released.

## [0.4.0] - 2026-11-24

### Added
- Terms with dates, score split and a positions setting; switching sessions clears the current term.
- State subject list, class subjects and subject teachers.
- Score sheets with draft, submit, approve and return; marks validated against each component's maximum.
- Broadsheet with averages and positions, report card remarks, release of class results, report cards with attendance, and a results summary for the Ministry.
- Subject teachers can view the students in classes they teach.
- End-to-end tests for results.

## [0.3.0] - 2026-11-24

### Added
- Daily attendance registers per class (present, late, absent, excused, with notes), with edit windows for class teachers and corrections by school administrators.
- School day overview, class summaries and per-student attendance; attendance counts on `GET /stats` and `registerTakenToday` on `GET /my/classes`.
- End-to-end tests for attendance.

### Changed
- "Today" is now the date in Nigeria (UTC+1) rather than UTC.
- Classes with attendance records cannot be removed.

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
