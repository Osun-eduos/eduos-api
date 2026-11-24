# eduos-api

**Application API, database and sync service for Osun EduOS.**

Part of [Osun EduOS](https://github.com/Osun-eduos/osun-eduos), the open-source education management and intelligence system for Osun State. The web app is [eduos-web](https://github.com/Osun-eduos/eduos-web).

## Status: milestone 1, accounts and sign-in

- Accounts for five user types: Ministry administrator, Ministry officer, school administrator, teacher and parent.
- Sign-in with an email address or a Nigerian phone number (`0803…`, `+234803…` and `234803…` all work).
- Schools with Osun school numbers (`OS/OSG/JSS/0001`), classified by LGA, level and ownership.
- Accounts are issued down the chain with temporary passwords; the user must set their own at first sign-in.
- Activity log of sign-ins and account changes.

Next milestones: students and classes, attendance, assessment and results, then the sync service for the Android and iOS apps. See the [roadmap](https://github.com/Osun-eduos/osun-eduos/blob/main/docs/roadmap.md).

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

| Action | Ministry admin | Ministry officer | School admin | Teacher | Parent |
| --- | --- | --- | --- | --- | --- |
| Register, edit, deactivate schools | ✓ | | | | |
| View all schools | ✓ | ✓ | own school | | |
| Create Ministry accounts | ✓ | | | | |
| Create school administrator accounts | ✓ | | | | |
| Create teacher and parent accounts | ✓ any school | | ✓ own school | | |
| Reset passwords, deactivate accounts | ✓ | | ✓ teachers & parents, own school | | |
| View accounts | ✓ all | ✓ all | own school | | |
| View activity log | ✓ all | | own school | | |
| Sign in, change own password | ✓ | ✓ | ✓ | ✓ | ✓ |

## API

All routes except sign-in, refresh, logout and health need `Authorization: Bearer <accessToken>`.

| Method and path | Purpose |
| --- | --- |
| `POST /auth/login` | `{ identifier, password }` → `{ accessToken, user }` and sets the refresh cookie |
| `POST /auth/refresh` | New access token from the refresh cookie (rotates the cookie) |
| `POST /auth/logout` | Revokes the refresh token |
| `POST /auth/change-password` | `{ currentPassword, newPassword }`; required first if `mustChangePassword` |
| `GET /auth/me` | The signed-in user |
| `GET /users`, `GET /users/:id` | Accounts the caller may see; filters `role`, `schoolId`, `q` |
| `POST /users` | Create an account → `{ user, tempPassword }` |
| `PATCH /users/:id` | Update name, email, phone or `isActive` |
| `POST /users/:id/reset-password` | New temporary password; unlocks and signs out everywhere |
| `GET /schools`, `GET /schools/:id`, `GET /schools/lgas` | Schools and the list of LGAs |
| `POST /schools` | Register a school, optionally with its administrator (`admin: { fullName, email?, phone? }`) |
| `PATCH /schools/:id` | Update name, address or `isActive` |
| `GET /stats` | Counts for the home screen |
| `GET /audit` | Activity log |
| `GET /health` | Liveness and database check |

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
