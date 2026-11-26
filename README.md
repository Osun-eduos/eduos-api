# eduos-api

**Application API, database and sync service for Osun EduOS.**

Part of [Osun EduOS](https://github.com/Osun-eduos/osun-eduos), the open-source education management and intelligence system for Osun State. The web app is [eduos-web](https://github.com/Osun-eduos/eduos-web).

## Status: phase 2, day-to-day operations

**Absence texts to parents**

- When a child is marked **absent** (not late or excused) on today's register, each parent with a phone number gets one text, about 15 minutes later (`ABSENCE_SMS_DELAY_MINUTES`). Correcting the register before then cancels it. At most one text per child, parent and day; texts not sent on the day are dropped.
- Sent through **KudiSMS** (`KUDISMS_TOKEN`, `KUDISMS_SENDER_ID`). The default `KUDISMS_ROUTE=corporate` is the transactional route, which needs an approved corporate sender ID and reaches numbers on DND. Without a token, texts are recorded but not sent, so everything can be tried safely.
- A background sender in the API sends due texts every minute, retries outages (up to 3 attempts) and does not retry refusals such as a bad number. Several API instances can run it at once (`FOR UPDATE SKIP LOCKED`); set `SMS_WORKER=off` to stop one sending.
- Schools can switch absence texts off. The Ministry sees every text, the KudiSMS balance, and can send a test message.

**Staff registry**

- Teaching and non-teaching staff, with or without a sign-in account: state staff number (`OSN-ST-000123`), job title, grade level and step, first appointment and years of service, TRCN number, subjects, qualifications and training.
- Postings: the full history of schools and dates. Schools ask for a transfer; the Ministry administrator approves or declines, or posts someone directly. A linked teacher's account moves with them: they are signed out and lose their class and subject assignments at the old school.
- Home screens show teaching and non-teaching staff and pupils per teacher.

**Infrastructure inspections**

- Inspectors and LGA education officers record visits on the mobile app: classrooms, toilets, water, power, safety and other facilities (`src/common/inspection.ts`), with photos and notes. Each visit gets an overall grade (good, fair, poor, critical) and a list of what needs attention.
- Uploads are idempotent (an id made on the phone), so a dropped connection never saves a visit or photo twice. Photos must be JPEG, PNG or WebP (checked from the file itself), at most 5 MB, 30 per visit.
- Photos are stored in any S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3) set with `S3_BUCKET` and its keys, and served only to people who can see the school. Without a bucket they are kept in the database, for development.

## Earlier milestones

**Milestone 4: results and report cards**

- Terms within each session, set by the Ministry, with dates, a score split (default CA 1 20, CA 2 20, Exam 60, adding up to 100) and a setting to show or hide class positions. One term is current across the state.
- A state subject list for primary, junior and senior secondary (`src/common/results.ts`). Schools choose each class's subjects, or add the usual ones in one step, and assign a teacher to each.
- Score sheets per subject, class and term. The subject teacher enters marks (whole or half marks, within each component's maximum), saves drafts and submits. The school administrator approves or returns with a note. Everything is recorded in the activity log.
- Grades: A to F for primary and junior secondary. For senior secondary the Ministry chooses, per term, between the WAEC scale (A1 to F9, the default) and A to F. The choice locks once that term's SSS results are released. Pass from 40, credit from 50.
- Class broadsheet with each student's average and position (equal averages share a position), class teacher's and principal's remarks, and release once every subject is approved. Released results cannot be changed.
- Report cards with marks, grade, class average, highest, lowest and position per subject, overall position, the term's attendance, remarks and the grading key. Parents see them once released; the school and class teacher can preview.
- Ministry results summary by school and by subject (average, pass and credit rates), from released results only.

**Milestone 3: attendance**

- A daily register per class: each student is marked present, late, absent or excused, with an optional note. Every student on the class roll must be marked; students admitted after that day are left out.
- Class teachers take and correct registers for the last 7 days; school administrators can correct any day in the current session. Weekends, future dates and dates outside the session are refused.
- Each change records who took or corrected the register, and goes in the activity log.
- School day overview (which classes have taken the register, with counts), class summaries and each student's attendance across classes and schools. Attendance rate counts days present or late.
- Parents see their own child's attendance. Home screen counts for schools and the Ministry.

**Milestone 2: students and classes**

- Academic sessions (`2026/2027`) opened by the Ministry; one is current at a time.
- Classes (`JSS 2A`) per school and session, limited to the levels the school teaches, with a capacity and a class teacher.
- Student enrolment with a state-wide **learner ID** (`OSN-26-000001`) that stays with the student for life, and a per-school admission number (`2026/0001`). Possible duplicates (same name and date of birth anywhere in the state) are flagged before enrolment.
- Parents and guardians linked to students, using an existing parent account or creating one with a temporary password.
- Class placement and moves, with capacity checks and class history.
- Transfers between Osun schools: the sending school requests, the receiving school accepts (with a new admission number and optional class) or declines. The record, learner ID and history move with the student, and a parent whose only children have moved follows them to the new school.
- Withdrawal for students leaving the state system; the record is kept.
- Teachers see the class they teach; parents see their own children.

**Milestone 1: accounts and sign-in**

- Accounts for seven user types: Ministry administrator, Ministry officer, LGA education officer, school inspector, school administrator, teacher and parent. LGA officers see only the schools in their LGA; inspectors see one LGA or the whole state. Both are read only.
- Sign-in with an email address or a Nigerian phone number (`0803…`, `+234803…` and `234803…` all work).
- Schools with Osun school numbers (`OS/OSG/JSS/0001`), classified by LGA, level and ownership.
- Accounts are issued down the chain with temporary passwords; the user must set their own at first sign-in.
- Activity log of sign-ins and account changes.

The mobile apps sync through [eduos-sync](https://github.com/Osun-eduos/eduos-sync) (Go), which shares this database and applies every change through this API. Its `SyncEvent` table is defined here, because this repository owns the schema.

Next milestones: the Android teacher app, SMS to parents, and the teacher registry. See the [roadmap](https://github.com/Osun-eduos/osun-eduos/blob/main/docs/roadmap.md).

## Stack

NestJS 11 · TypeScript · PostgreSQL 16 · Prisma 6 · Argon2id password hashing · JWT access tokens · rotating refresh tokens in httpOnly cookies.

## Run locally

You need Node.js 22 and Docker (or your own PostgreSQL 16).

```bash
git clone https://github.com/Osun-eduos/eduos-api.git
cd eduos-api
npm install
cp .env.example .env               # then set JWT_ACCESS_SECRET (openssl rand -base64 48)
docker compose up -d db            # PostgreSQL on localhost:5432
npx prisma migrate deploy          # create the tables
SEED_ADMIN_EMAIL=you@example.com npm run db:seed   # first Ministry administrator; prints a temporary password
npm run start:dev                  # API on http://localhost:3000
```

Then start [eduos-web](https://github.com/Osun-eduos/eduos-web) and sign in with the seeded account.

To run everything in containers: `docker compose --profile app up --build`.

## Tests

End-to-end tests run against a real, disposable PostgreSQL database. They erase it first.

```bash
createdb eduos_test
DATABASE_URL=postgresql://eduos:eduos@localhost:5432/eduos_test npx prisma migrate deploy
DATABASE_URL=postgresql://eduos:eduos@localhost:5432/eduos_test npm run test:e2e
```

They cover sign-in by email and phone, the forced password change, who may create which accounts, school scoping, duplicate detection, lockout and reset, refresh-token rotation and reuse detection, deactivation of accounts and schools, and the activity log. GitHub Actions runs them on every push (`.github/workflows/ci.yml`).

## Who can do what

LGA education officers and inspectors have the Ministry officer's read-only access, limited to their LGA (an inspector without an LGA covers the whole state). They cannot see accounts or the activity log.

| Action | Ministry admin | Ministry officer | School admin | Teacher | Parent |
| --- | --- | --- | --- | --- | --- |
| Register, edit, deactivate schools | ✓ | | | | |
| View all schools | ✓ | ✓ | own school | | |
| Create Ministry, LGA officer and inspector accounts | ✓ | | | | |
| Create school administrator accounts | ✓ | | | | |
| Create teacher and parent accounts | ✓ any school | | ✓ own school | | |
| Reset passwords, deactivate accounts | ✓ | | ✓ teachers & parents, own school | | |
| View accounts | ✓ all | ✓ all | own school | | |
| View activity log | ✓ all | | own school | | |
| Sign in, change own password | ✓ | ✓ | ✓ | ✓ | ✓ |
| Open and switch academic sessions | ✓ | | | | |
| Set holidays (no registers on those days) | ✓ | | | | |
| Create classes, assign class teachers | | | ✓ own school | | |
| Enrol, edit, place, withdraw students; link parents | | | ✓ own school | | |
| Add and edit staff, qualifications and training | ✓ | | ✓ own school | | |
| Ask for a staff transfer | | | ✓ own school | | |
| Approve staff transfers, post staff | ✓ | | | | |
| Switch absence texts on or off | ✓ any school | | ✓ own school | | |
| See the text message log | ✓ all | ✓ all | own school | | |
| Import students from a spreadsheet | | | ✓ own school | | |
| Request, accept, decline, cancel transfers | | | ✓ own school | | |
| View students | ✓ all | ✓ all | own school | own class | own children |
| View transfers | ✓ all | ✓ all | in and out of own school | | |
| Take and correct registers | | | ✓ own school, any day this session | ✓ own class, last 7 days | |
| View attendance | ✓ all | ✓ all | own school | own class | own children |
| Set up terms, score split, positions and SSS grading | ✓ | | | | |
| Choose class subjects and subject teachers | | | ✓ own school | | |
| Enter and submit scores | | | ✓ own school | ✓ own subjects | |
| Approve or return scores, release results | | | ✓ own school | | |
| Write report card remarks | | | ✓ principal's | ✓ class teacher's | |
| View results and report cards | ✓ released | ✓ released | own school | own class (preview) | own children, released |

## API

All routes except sign-in, refresh, logout and health need `Authorization: Bearer <accessToken>`.

| Method and path | Purpose |
| --- | --- |
| `POST /auth/login` | `{ identifier, password }` → `{ accessToken, user }` and sets the refresh cookie |
| `POST /auth/refresh` | New access token from the refresh cookie (rotates the cookie) |
| `POST /auth/logout` | Revokes the refresh token |
| `POST /auth/login`, `/auth/refresh`, `/auth/logout` with `X-Client: mobile` | For the mobile apps: the refresh token is returned in, and sent back in, the JSON body (`refreshToken`) instead of a cookie |
| `POST /auth/change-password` | `{ currentPassword, newPassword }`; required first if `mustChangePassword` |
| `GET /auth/me` | The signed-in user |
| `GET /users`, `GET /users/:id` | Accounts the caller may see; filters `role`, `schoolId`, `q` |
| `POST /users` | Create an account → `{ user, tempPassword }` |
| `PATCH /users/:id` | Update name, email, phone or `isActive` |
| `POST /users/:id/reset-password` | New temporary password; unlocks and signs out everywhere |
| `GET /schools`, `GET /schools/:id`, `GET /schools/lgas` | Schools and the list of LGAs |
| `POST /schools` | Register a school, optionally with its administrator (`admin: { fullName, email?, phone? }`) |
| `PATCH /schools/:id` | Update name, address or `isActive` |
| `GET /sessions`, `GET /sessions/current` | Academic sessions |
| `POST /sessions`, `POST /sessions/:id/make-current` | Open a session `{ name, startDate, endDate }`; switch the current one |
| `GET /classes`, `GET /classes/levels` | Classes for a school and session; the levels a school may teach |
| `POST /classes`, `PATCH /classes/:id`, `DELETE /classes/:id` | `{ level, arm, capacity?, classTeacherId? }`; only empty classes can be deleted |
| `GET /students` | Filters `q`, `schoolId`, `classId`, `status`, `unplaced` |
| `POST /students` | Enrol → `{ student, parent }` (parent has a temporary password if newly created); `409 POSSIBLE_DUPLICATE` unless `confirmDuplicate` |
| `GET /students/:id`, `PATCH /students/:id` | Full record with guardians, schools attended, class history and transfers |
| `POST /students/:id/placement` | `{ classArmId }` or `null` to remove from class |
| `POST /students/:id/guardians`, `DELETE /students/:id/guardians/:parentId` | Link or unlink a parent |
| `POST /students/:id/withdraw` | `{ reason }` |
| `GET /transfers`, `POST /transfers` | `{ studentId, toSchoolId, reason }` |
| `POST /transfers/:id/accept`, `/reject`, `/cancel` | Receiving school accepts `{ classArmId?, admittedOn? }` or rejects `{ note? }`; sending school cancels |
| `GET /my/classes`, `GET /my/children` | Teacher's classes with students; parent's children |
| `GET /attendance/register?classId&date` | A class's register for a day, with `editable` and `lockedReason` |
| `PUT /attendance/register` | `{ classId, date, marks: [{ studentId, status, note? }] }`; status is `PRESENT`, `LATE`, `ABSENT` or `EXCUSED` |
| `GET /attendance/day?date&schoolId` | Which classes have taken the register on a day, with counts |
| `GET /attendance/class?classId&from&to` | Per-student and per-day totals for a class (default: the session so far) |
| `GET /attendance/students/:id?from&to` | One student's attendance and rate |
| `GET /terms`, `GET /terms/current` | Terms of a session |
| `POST /terms`, `PATCH /terms/:id`, `POST /terms/:id/make-current` | `{ number, startDate, endDate, components?, showPositions?, sssGrading? }`; `sssGrading` is `WAEC` or `BASIC` |
| `GET /subjects?level`, `GET /grading` | Subject list for a class level; grading scales |
| `GET /classes/:id/subjects`, `POST /classes/:id/subjects`, `POST /classes/:id/subjects/core` | A class's subjects; add one; add the usual ones |
| `PATCH /class-subjects/:id`, `DELETE /class-subjects/:id` | Set the subject teacher; remove a subject with no scores |
| `GET /my/subjects` | A teacher's subjects with this term's status |
| `GET /scoresheets?classSubjectId&termId`, `PUT /scoresheets` | Read or save marks `{ classSubjectId, scores: [{ studentId, marks: { CA1, CA2, EXAM } }] }` |
| `POST /scoresheets/:id/submit`, `/approve`, `/return` | Submit; approve; return `{ note }` |
| `GET /results/class?classId&termId` | Broadsheet, subject statuses and what blocks release |
| `PUT /results/remarks`, `POST /results/release` | Save remarks; release a class's results |
| `GET /report-cards/:studentId?termId`, `GET /report-cards/:studentId/terms` | A report card; the terms a student has report cards for |
| `GET /results/summary?termId&schoolId` | Released results by school and subject |
| `GET /schools/directory` | Every active school (for choosing a transfer destination) |
| `GET /stats` | Counts for the home screen |
| `GET /audit` | Activity log |
| `GET /health` | Liveness and database check |


### Staff, inspections and text messages

| Method and path | Purpose |
| --- | --- |
| `GET /staff?schoolId=&q=&category=&status=` | Staff the caller may see (current staff unless a status is given) |
| `POST /staff`, `PATCH /staff/:id` | Add or edit a staff record. Marking someone LEFT or RETIRED ends their posting |
| `POST /staff/:id/qualifications`, `POST /staff/:id/trainings` | Record qualifications and training (and `DELETE` to remove one) |
| `PATCH /staff/:id/account` | `{ userId }` links a teacher or administrator account at the same school (`null` unlinks) |
| `POST /staff/:id/postings` | Ministry admin: post someone to another school |
| `GET/POST /staff-transfers`, `POST /staff-transfers/:id/approve\|reject\|cancel` | Transfer requests from schools, decided by the Ministry |
| `GET /my/staff-record` | The signed-in person's own staff record |
| `GET /inspections/template` | The checklist the apps draw their forms from |
| `GET /inspections?schoolId=&overall=&mine=` | Visits the caller may see |
| `POST /inspections` | Inspectors and LGA officers: `{ clientId, schoolId, visitedOn, answers, notes }` |
| `POST /inspections/:id/photos` | Multipart: `photo`, `clientId`, `section`, `caption` |
| `GET /inspections/photos/:photoId` | The image, for people who can see the school |
| `GET /sms`, `GET /sms/summary` | Text message log and today's counts |
| `PATCH /sms/settings` | `{ absenceSms }` for the school (Ministry admin: with `schoolId`) |
| `POST /sms/test` | Ministry admin: `{ phone }` sends a test message now |

### Holidays and spreadsheet imports

| Method and path | Purpose |
| --- | --- |
| `GET /holidays?sessionId=` | Holidays in a session (the current one by default) |
| `POST /holidays` | Ministry admin: `{ name, startDate, endDate? }`. Registers are refused on these days |
| `POST /holidays/national` | Ministry admin: `{ sessionId }` adds the fixed-date federal holidays, Good Friday and Easter Monday, skipping any already set |
| `DELETE /holidays/:id` | Ministry admin: remove a holiday |
| `POST /students/import` | School admin: `{ rows, dryRun? }`, up to 500 rows. Checks every row (names, sex, dates read day first, class by name, capacity, duplicates in the file and the state, parent phone or email). With `dryRun` nothing is saved; otherwise the ready rows are enrolled in one transaction and new parents' temporary passwords are returned once |

## Deploy

[`render.yaml`](render.yaml) puts the database, this API, [eduos-sync](https://github.com/Osun-eduos/eduos-sync) and [eduos-web](https://github.com/Osun-eduos/eduos-web) online on Render in one step. Follow the [deployment guide](https://github.com/Osun-eduos/osun-eduos/blob/main/docs/deployment.md).

The Docker image runs [`scripts/start.sh`](scripts/start.sh) on start-up:

1. It applies database migrations.
2. If `SEED_ADMIN_EMAIL` (or `SEED_ADMIN_PHONE`) is set and no Ministry administrator exists yet, it creates one with `SEED_ADMIN_NAME` and the temporary password `SEED_ADMIN_PASSWORD`.
3. It starts the API.

## Security notes

- Passwords are hashed with Argon2id. Wrong-password responses are identical whether or not the account exists.
- Five failed sign-ins lock an account for 15 minutes. Sign-in is also rate-limited per IP address (`LOGIN_RATE_LIMIT`).
- Access tokens last 15 minutes and are held in memory by the web app. Refresh tokens are random, stored only as SHA-256 hashes, sent in an httpOnly `SameSite=Strict` cookie, and rotated on every use. Reusing an old refresh token after a 10-second grace period signs the account out everywhere.
- Users with a temporary password can do nothing except change it.
- Configuration is in `.env.example`. In production use HTTPS, a long random `JWT_ACCESS_SECRET`, `COOKIE_SECURE=true` and `TRUST_PROXY` if behind a load balancer.
- Never commit real personal data, including in tests and fixtures. This service will hold records about children; design for the Nigeria Data Protection Act 2023.

## Contributing

See the organisation-wide [contributing guide](https://github.com/Osun-eduos/.github/blob/main/CONTRIBUTING.md).

## Licence

[GNU Affero General Public License v3.0](LICENSE).
