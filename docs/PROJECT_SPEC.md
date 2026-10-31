# Rental Record Project Specification

Rental Record is a web application for renters in the United States to document a home's condition room by room at move-in and move-out. Each checklist item keeps its condition, notes, inspection date, and photos together. Completed reports are versioned, printable, and shareable through revocable read-only links.

The application, source documentation, validation messages, and operational instructions are written in English.

## 1. Product goal

A renter should be able to record an existing scratch, stain, broken fixture, or inaccessible area without turning the process into a legal determination. The application preserves what the renter observed and when the inspection was performed. It does not decide who caused damage, estimate repair costs, or certify when an original photo was taken.

The primary portfolio problem is not a checklist form. It is preserving trustworthy versions across two inspections while keeping photos private and access boundaries explicit.

## 2. Version-one scope

Version one includes:

- email accounts in hosted mode and two fixed accounts in local demo mode;
- one editable owner per rental record;
- address, time zone, rooms, and customizable checklist items;
- move-in and move-out inspections;
- explicit item conditions, notes, and private photos;
- immutable completed report versions;
- side-by-side move-in and move-out comparison;
- browser printing and PDF export;
- expiring, revocable, read-only report links;
- archive, soft deletion, and retryable file cleanup;
- local PGlite/file storage and hosted PostgreSQL/Supabase storage modes.

Version one does not include collaborative editing, landlord accounts, comments, signatures, automatic damage detection, cost estimates, native mobile applications, HEIC decoding, or legal conclusions.

## 3. Main user journey

### Create a rental record

1. Sign in.
2. Create a record with a title, city, state, time zone, and optional street, unit, and ZIP code.
3. Select at least one room type.
4. Review the generated rooms and checklist items.
5. Rename, add, or remove rooms and items before completing the first report.

### Record move-in condition

1. Open the move-in inspection.
2. Set the inspection date.
3. Select a condition for every item.
4. Add required notes and optional photos.
5. Review incomplete or invalid entries.
6. Complete report version 1.

### Correct a completed report

1. Reopen the completed inspection.
2. Edit the draft without changing earlier reports.
3. Complete a new report version.
4. Confirm that previous versions still show their original notes and photos.

### Record move-out condition

1. Start move-out from the latest completed move-in report.
2. Keep the same room and item IDs as the baseline.
3. Begin with blank move-out observations rather than copied answers.
4. Complete the move-out report.
5. Review the side-by-side comparison.

### Share a report

1. Open one completed report version.
2. Create a link that expires in 1, 7, or 30 days.
3. Open the link without signing in.
4. Revoke the link and confirm that both report and photo access stop.

## 4. Users and permissions

An authenticated owner may create, read, edit, archive, and delete only records they own. Ownership is checked by the API for every protected resource; hiding a button in the browser is never treated as authorization.

A shared-report visitor may read exactly one completed report and only the photos captured by that report. A share token does not grant access to the rental record, drafts, other report versions, account details, or editing operations.

The database is kept behind the Express API. Browser clients do not receive direct access to the `app` schema or the private photo bucket.

## 5. Information architecture

The application provides these screens:

- landing page;
- sign in, sign up, email callback, forgot password, and reset password;
- active and archived rental record lists;
- new rental record form;
- rental record overview;
- address, room, and checklist setup;
- room-by-room inspection workspace;
- completion review;
- completed report list and report detail;
- move-in/move-out comparison;
- shared read-only report;
- print layout.

Protected routes redirect unauthenticated users to sign in and return them to the requested path after authentication.

## 6. Rental record and checklist

A rental record contains:

- title, up to 80 characters;
- city, up to 80 characters;
- two-letter U.S. state code;
- optional street, unit, and ZIP code;
- IANA time zone;
- archive and deletion timestamps;
- created and updated timestamps.

A record supports at most 10 rooms and 60 checklist items. Room names are limited to 60 characters and item names to 80 characters.

Default room types and suggested items are:

| Room type   | Suggested items                                                       |
| ----------- | --------------------------------------------------------------------- |
| Living room | Walls, ceiling, floor, windows, door, lights                          |
| Bedroom     | Walls, ceiling, floor, windows, door, closet                          |
| Kitchen     | Walls, floor, sink, faucet, cabinets, countertop, refrigerator, stove |
| Bathroom    | Walls, floor, sink, faucet, toilet, shower or tub, ventilation        |
| Hallway     | Walls, floor, doors, lights                                           |
| Laundry     | Floor, washer, dryer, visible connections                             |
| Other       | General condition                                                     |

Defaults are starting points, not a claim that every property contains those features.

## 7. Observation rules

Every checklist item has one of these values:

| Internal value   | Display meaning   | Notes requirement    |
| ---------------- | ----------------- | -------------------- |
| `null`           | Not recorded      | Prevents completion  |
| `no_issue`       | No issue observed | Optional             |
| `issue`          | Issue noted       | Required description |
| `not_applicable` | Not applicable    | Required reason      |
| `not_checked`    | Unable to inspect | Required reason      |

Notes are trimmed and limited to 2,000 characters. A user must explicitly save an observation. A failed request preserves unsaved text and selected files so the user can retry.

Each inspection carries an `editVersion`. Every successful mutation increments it. A request with an older version receives `409 Conflict` rather than overwriting newer work from another tab.

## 8. Dates and time zones

Inspection dates are date-only values in the rental record's selected time zone. The server validates that a value is a real Gregorian calendar date in `YYYY-MM-DD` form.

Timestamps such as creation, upload, expiration, and revocation are stored as instants and rendered in the record's time zone. A date-only inspection value must not shift because the viewer is in another time zone.

## 9. Photo handling

Selecting a file and uploading it are separate actions. The interface must not imply that a local preview has already been saved.

Accepted inputs are still JPEG, PNG, and WebP images up to 10 MiB and 50 megapixels. Each item supports up to 5 current photos and each inspection up to 40.

The API performs this sequence:

1. Verify ownership, editability, limits, and the client upload ID.
2. Insert a pending photo row.
3. Decode the actual image rather than trusting the file extension or MIME header.
4. Apply orientation, remove metadata, and create WebP copies.
5. Limit the full image's long edge to 2,400 pixels.
6. Create a 1,200-pixel preview.
7. Store both copies in private storage.
8. Recheck that the record and observation still exist.
9. Mark the row ready or preserve a retryable failure state.

The service does not keep the original upload. Users who need original files must retain them separately.

Photo bytes are served only through authorized API routes. Storage keys are not public URLs. A shared photo request verifies that the photo belongs to the requested report.

## 10. Completed reports and versions

An inspection is mutable; a completed report is immutable.

Completion is allowed only when:

- the inspection date is valid;
- every current item has a condition;
- required notes are present;
- no current photo is pending or failed;
- the expected edit version is current.

Completion runs in one database transaction. It locks the rental record and inspection, validates the draft, creates a JSON snapshot, records the exact included photos, increments the report version, and marks the inspection completed.

The request includes a client-generated `requestId`. Repeating the same request returns the existing report instead of creating a duplicate.

Reopening changes the inspection back to a draft. It never updates or deletes an earlier report snapshot. A photo removed from a later draft remains in storage while any completed report references it.

## 11. Move-out baseline and comparison

Move-out may start only after at least one completed move-in report exists. Starting move-out stores the latest completed move-in report ID as the permanent baseline.

Opening a later move-in revision does not change an already-started move-out baseline. The operation locks the rental record so that move-out creation and move-in reopening cannot race.

Comparison categories are:

- unrecorded when either side has no condition;
- unavailable when either side is `not_checked`;
- changed when conditions differ;
- review notes when both sides are `issue`;
- same selection otherwise.

The interface may filter these categories, but printing includes the full report rather than silently omitting filtered items.

## 12. Sharing

A share link belongs to one report version. Its raw token is shown in the URL but only a SHA-256 hash is stored in the database.

Only one unrevoked link is active for a report at a time. Creating a new link revokes the prior active link. Expiration must be in the future and is selected from 1, 7, or 30 days.

Shared responses use private, no-store caching and a no-referrer policy. Shared paths must be masked or excluded from proxy and hosting access logs because the token is part of the path.

Revocation immediately prevents both report and photo access.

## 13. Archive, deletion, and cleanup

Archiving hides a record from the active list without removing data.

Deletion requires the user to type the record title. The database record is soft-deleted first. File deletion then runs through a retryable cleanup process so a storage outage does not restore user access or lose track of pending work.

The cleanup job:

- retries files associated with deleted records;
- removes photos no longer referenced by a current draft or completed report;
- removes orphaned storage objects after a safety period;
- never removes a photo still referenced by `report_photos`.

The same cleanup command may run repeatedly. Production should schedule it daily.

## 14. Technical architecture

The repository is an npm workspace:

```text
apps/web                 React and Vite client
apps/api                 Express API and business services
packages/contracts       Shared types, constants, and Zod schemas
db/migrations            PostgreSQL schema migrations
scripts                  Migration, seed, cleanup, and build entry points
tests/api                SQL and image integration tests
tests/e2e                Playwright browser workflows
docs                     Setup, testing, code guide, and product specification
```

The web application uses React, TypeScript, React Router, TanStack Query, React Hook Form, and CSS Modules.

The API uses Express, PostgreSQL through `pg`, PGlite for local mode, Supabase Auth and Storage for hosted mode, Zod for validation, and Sharp for image processing.

Production serves the built frontend and `/api` from one Express origin.

## 15. Runtime modes

### Demo mode

- binds only to a loopback host;
- refuses `NODE_ENV=production`;
- uses PGlite under `.data/db`;
- stores private WebP files under `.data/photos`;
- provides Jordan and Taylor demo accounts;
- signs four-hour in-memory sessions;
- requires no external account.

### Supabase mode

- requires PostgreSQL, Supabase URL, anonymous key, service-role key, and a private bucket;
- validates HTTPS in production;
- verifies Supabase access tokens at the API;
- uses the service role only on the server;
- verifies at startup that the photo bucket is private.

The business schema and service rules are shared between both modes.

## 16. Data model

| Table           | Purpose                                      |
| --------------- | -------------------------------------------- |
| `stays`         | Owner and rental address metadata            |
| `rooms`         | Ordered room structure                       |
| `check_items`   | Ordered checklist items                      |
| `inspections`   | Mutable move-in or move-out draft            |
| `observations`  | Condition and notes for one item             |
| `photos`        | Private transformed photo metadata and state |
| `reports`       | Immutable JSON snapshots and report versions |
| `report_photos` | Photos retained by a completed report        |
| `share_links`   | Hashed, expiring, revocable report access    |

Composite foreign keys include `stay_id` to prevent IDs from different rental records being combined. Unique constraints protect inspection kind, observation item, report version, completion request, and upload request boundaries.

The database rejects updates to completed report rows with a trigger.

## 17. API outline

Public and authentication routes:

```text
GET    /api/health
GET    /api/config
POST   /api/demo/login
GET    /api/shared/:token
GET    /api/shared/:token/photos/:photoId
```

Authenticated rental record routes:

```text
GET    /api/me
GET    /api/stays
POST   /api/stays
GET    /api/stays/:stayId
PATCH  /api/stays/:stayId
DELETE /api/stays/:stayId
GET    /api/stays/:stayId/setup
POST   /api/stays/:stayId/archive
POST   /api/stays/:stayId/unarchive
```

Structure and inspection routes:

```text
POST   /api/stays/:stayId/rooms
PATCH  /api/rooms/:roomId
DELETE /api/rooms/:roomId
POST   /api/rooms/:roomId/items
PATCH  /api/items/:itemId
DELETE /api/items/:itemId
GET    /api/inspections/:inspectionId
PATCH  /api/inspections/:inspectionId
PATCH  /api/observations/:observationId
POST   /api/inspections/:inspectionId/complete
POST   /api/inspections/:inspectionId/reopen
POST   /api/stays/:stayId/move-out
GET    /api/stays/:stayId/comparison
```

Photo and report routes:

```text
POST   /api/observations/:observationId/photos
DELETE /api/photos/:photoId
GET    /api/photos/:photoId/content
GET    /api/stays/:stayId/reports
GET    /api/reports/:reportId
POST   /api/reports/:reportId/share-links
GET    /api/reports/:reportId/share-links
DELETE /api/share-links/:shareId
```

## 18. Error behavior

Errors use this shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Check the highlighted fields.",
    "details": [],
    "requestId": "uuid"
  }
}
```

Expected status categories include:

- `400` malformed input or unsupported request;
- `401` missing or invalid authentication;
- `403` disallowed origin, host, or operation;
- `404` missing or inaccessible resource;
- `409` stale edit version or conflicting state;
- `413` upload too large;
- `422` field validation failure;
- `429` rate limit;
- `500` unexpected internal error without sensitive details.

Server logs use a request ID and must not log shared-report URLs.

## 19. Security and privacy requirements

- Demo mode is local only.
- Production uses HTTPS.
- Database credentials and service-role keys remain server-side.
- The private bucket has no browser read or write policy.
- The API validates ownership on every mutation and protected read.
- Image bytes are decoded, transformed, and served with a fixed content type.
- JSON and multipart request sizes are limited.
- Login, shared reads, and uploads are rate-limited.
- Responses set security headers through Helmet.
- Shared responses prevent referrer leakage and caching.
- Deleted data remains inaccessible while cleanup retries.

## 20. Accessibility and responsive behavior

The interface uses semantic labels, headings, buttons, links, dialogs, progress elements, status regions, and keyboard focus. A skip link is the first keyboard target.

The checklist must remain usable at a 390-pixel viewport without horizontal overflow. At 200% zoom, form fields and actions must not overlap. Error text appears near the related control and is not communicated by color alone.

Dialogs restore focus when closed. Unsaved changes trigger an in-app navigation warning and a browser unload warning.

### Visual design direction

The interface should feel like a practical condition notebook, not a generic software marketing template. Layout and copy use the actual work—rooms, dates, checklist items, notes, photos, and report versions—as the visual hierarchy.

- Use warm paper, near-black ink, restrained green, and a rust action color.
- Prefer ruled sections, lists, and square or lightly rounded controls over repeated floating cards.
- Keep shadows rare and functional. Do not use decorative gradients, glass effects, oversized icon tiles, or interchangeable three-column feature strips.
- Use asymmetry when it helps reading order. Application pages may be denser than the landing page because they are working documents.
- Reserve badges for real status. Do not add pills, metrics, or decorative labels merely to fill space.
- Write concrete interface copy. Avoid vague claims and repeated headline/subheadline/card patterns.
- Preserve keyboard focus, contrast, 200 percent zoom, and narrow-screen behavior while changing visual treatment.

## 21. Testing and acceptance criteria

Automated checks cover:

- domain dates, conditions, comparisons, and runtime boundaries;
- API authentication, ownership, validation, and database constraints;
- stale editing, idempotent completion, and concurrent lifecycle operations;
- photo validation, limits, retries, races, and historical retention;
- report sharing, expiration, revocation, and photo authorization;
- deletion and cleanup;
- private bucket startup checks;
- browser creation, editing, completion, comparison, sharing, recovery, and mobile layout.

Manual checks cover hosted email flows, real Supabase storage, external HTTPS deployment, physical mobile devices, print preview, generated Letter-size PDF, keyboard navigation, zoom, and restoration from database plus photo backups.

The project is complete when a fresh Node.js 24 installation can run `npm ci`, all checks pass, the app builds, demo mode starts without external services, and the documented primary journey works from a clean data directory.

## 22. Development sequence

1. Define scope, rules, and acceptance criteria.
2. Bootstrap the workspace and shared contracts.
3. Add schema constraints and local adapters.
4. Implement API services from ownership boundaries outward.
5. Add integration tests before depending on the browser UI.
6. Build a runnable authentication shell.
7. Add record setup, inspection, and report vertical slices.
8. Add browser tests, deployment packaging, CI, and operational documentation.

The detailed commit and writing sequence is documented under `docs/build-from-scratch`.

## 23. Deployment and operations

Production requires Node.js 24, PostgreSQL, a Supabase project, a private storage bucket, HTTPS, and environment variables supplied by the hosting platform.

Deployment runs:

```bash
npm ci
npm run db:migrate
npm run build
npm run start
```

Operations must schedule `npm run cleanup`, monitor failed uploads and deletions without logging tokens, and back up the database and private photo bucket together. A database-only restore is incomplete because report snapshots reference stored photo files.

## 24. Demonstration script

1. Sign in as Jordan and show the existing example.
2. Create a new rental record and customize one room.
3. Record an issue with a note and photo.
4. Show completion blocking on an unrecorded item.
5. Complete move-in report version 1.
6. Reopen, change a note, and complete version 2.
7. Show that version 1 is unchanged.
8. Start move-out and complete a changed item.
9. Open the comparison and print preview.
10. Create a share link and open it in a private window.
11. Revoke the link and show that access stops.
12. Sign in as Taylor and demonstrate owner isolation.

## 25. Future work

Possible later work includes collaborative roles, landlord invitations, signatures, comments, configurable templates, export bundles, HEIC processing, background job infrastructure, audit views, restore tooling, additional locales, and native mobile capture. None of these should weaken immutable report versions or private photo authorization.
