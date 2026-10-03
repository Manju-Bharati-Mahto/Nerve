# Casting registration — photo upload straight into Google Drive

> Design spec, 4 October 2026. Casting module, external registration intake.
>
> **The applicant uploads a photo. Nerve puts it in the Casting Manager's Google
> Drive, in a folder named after the request. Nerve keeps the Drive ids, never
> the image.**

## The problem

The public registration form (`/casting/register/<token>`) asks the applicant
for a *Google Drive link* to their photo. They have to upload the photo to their
own Drive, work out sharing, and paste a link — the single most common reason a
submission stalls ("a link we cannot open"). The Casting Manager then sees a
link, not a photo, in the request drawer and on the record after approval.

## What changes

1. The form says **Upload photo**. The applicant picks a file from their phone
   or computer; the form shows a thumbnail and the file name.
2. On submit, the server stores the photo in the configured Google Drive, under
   `<Casting Registrations>/<CR-xxxxx>/`, creating the request's folder.
3. The request row records the Drive file id, folder id and MIME type. The
   legacy `photo_url` column is set to the file's Drive web link, so existing
   "Open Google Drive" buttons keep working.
4. The request drawer in **Casting Management** shows the photo, streamed from
   Drive through Nerve (`GET /casting-requests/:id/photo`), Casting Manager only.
5. **Approval** carries the photo to the casting record (`photo_file_id`,
   `photo_mime`) and sets the record's `drive_url` to the request's folder link.
6. **Casting Preview** cards and the record drawer show the photo, streamed
   through Nerve (`GET /casting/:id/photo`), under exactly the visibility rule
   the list already applies (managers see all; the crew sees confirmed, active
   records only).

## Approaches considered

| | Approach | Verdict |
|---|---|---|
| A | **Server-side upload to Drive, reusing the existing Drive client** (chosen) | One set of credentials, no Google code in the browser, the applicant never signs in to Google. Nerve stays an index over Drive (D5). |
| B | Google Picker / Drive API in the browser, applicant uploads to the Manager's Drive | Needs an OAuth client exposed to a public page and consent from a person who has no Nerve account; the Drive would have to be shared to "anyone". Rejected. |
| C | Store photos on Nerve's disk under `/uploads`, link from Drive later | Breaks the module's rule that media lives in Drive; the public `/uploads` mount would expose applicants' photos by URL. Rejected. |

## Architecture

```
browser (public form) ──multipart──▶ POST /api/v1/public/casting/:token/submit
                                        │ validate identity, consent, fields (unchanged)
                                        │ INSERT request row (CR code allocated)      ─┐ compensating
                                        │ storeCastingPhoto(CR code, staged file) ──▶  │ delete on
                                        │ UPDATE row with Drive ids                   ─┘ Drive failure
                                        │ audit + notify Casting Managers
                                        ▼
                             Google Drive: <casting root>/<CR-00012>/CR-00012-photo-<stamp>.jpg

Casting Management drawer ──▶ GET /api/v1/media/casting-requests/:id/photo ──▶ Drive stream
Casting Preview card/drawer ─▶ GET /api/v1/media/casting/:id/photo          ──▶ Drive stream
```

### Components

**`server/integrations/google-drive.ts`** — the Drive REST client classes, moved
verbatim out of `server/outreach-video/drive-client.ts` because nothing in them
is video-specific: `GoogleDriveClient`, `LocalDriveClient`, `DriveClient`,
`DriveFileMeta`, `RevisionMismatchError`, `DRIVE_FOLDER_MIME`, plus
`googleDriveCredentialsConfigured()`. `drive-client.ts` re-exports them and
keeps only the video root selection (`getDriveClient`, `driveIsConfigured`,
`driveIsLocal`, `DriveNotConfiguredError`). No behaviour change for Outreach.

**`server/casting-photos.ts`** — the one place that knows where casting photos
live.
- `castingPhotosConfigured()` — true when Google credentials **and**
  `GOOGLE_DRIVE_CASTING_FOLDER_ID` are set, or when `DRIVE_LOCAL_ROOT` is set
  (dev/tests; photos land under `<root>/casting-photos/`).
- `storeCastingPhoto({ requestCode, localPath, mimeType })` → `{ fileId,
  folderId, mimeType, webViewUrl, folderUrl }`. Ensures `<root>/<CR code>/`,
  uploads as `<CR code>-photo-<yyyyMMdd-HHmmss>.<ext>`. A re-submission adds a
  new file; the row points at the latest. Older files stay in the folder as
  history (no delete call, nothing lost).
- `openCastingPhoto(fileId)` → `{ body, status, headers }` for streaming.
- `CASTING_PHOTO_MIME` = `image/jpeg`, `image/png`, `image/webp`;
  `CASTING_PHOTO_MAX_BYTES` = 8 MB. Extension is derived from the validated
  MIME, never from the uploaded filename (same rule as avatars).
- In local mode `webViewUrl`/`folderUrl` are `null` — ids are paths, not links.

**`server/index.ts`** — builds `castingPhotoUpload` (multer, disk staging in
`os.tmpdir()/nerve-casting-photos`, **not** under the public `/uploads` mount)
and passes it to `registerMediaOpsApi` like `assetImportUpload`. Missing in the
integration suites ⇒ pass-through, same as the other optional handlers.

**`server/mediaops-api.ts`**
- `GET /public/casting/:token` adds `photo_upload: boolean`. The form shows the
  upload control when true and the legacy link field when false, so a server
  without Drive credentials keeps working exactly as today.
- `POST /public/casting/:token/lookup` adds `existing.has_photo`.
- `POST /public/casting/:token/submit` accepts either JSON (unchanged) or
  `multipart/form-data` with a `payload` field (the same JSON) and a `photo`
  file. The multer middleware is wrapped so its errors become 400s with a
  message the applicant can act on ("Your photo is larger than 8 MB", "Only
  JPG, PNG or WEBP") instead of the generic 500 the global handler returns.
  Rules: a file wins; otherwise a valid `photo_url` is still accepted (a stale
  tab); a re-submission with neither keeps the photo already on file; a first
  submission with neither is a 400 "Please upload your photo." The staged file
  is unlinked in `finally`, always.
- Ordering for a first submission: validate → INSERT (code allocated, unique
  index catches a race) → Drive upload → UPDATE photo columns → audit/notify.
  If Drive fails, the row is deleted and the applicant gets 502 "Your photo
  could not be saved. Please try again." No transaction is held across the
  upload (server/db-pool-safety.test.ts forbids holding a client while awaiting
  anything that is not that client).
- `POST /casting-requests/:id/review` (approve) copies `photo_file_id`,
  `photo_mime` to the new record and sets `drive_url` to the folder link when
  there is one, else to `photo_url` as today.
- `GET /casting-requests/:id/photo` — `castingAdmin` only; streams from Drive;
  `Cache-Control: private, max-age=300`.
- `GET /casting/:id/photo` — `requireMedia`; non-managers only for rows matching
  `PREVIEW_WHERE`. 404 when the record has no photo, 503 when Drive is not
  configured, 502 when Drive fails.

**`server/mediaops-db.ts`** — `mo_casting_requests` gains `photo_file_id`,
`photo_folder_id`, `photo_mime` (via `REQ_COLS`); `mo_casting_records` gains
`photo_file_id`, `photo_mime`. All nullable; the `/state` read model ships
them automatically (`to_jsonb`).

**`public/casting/app.js` + `index.html`** — the Photo card becomes an upload
control: hidden `<input type="file" accept="image/jpeg,image/png,image/webp">`,
a big "Upload photo" button, then a thumbnail (object URL), file name and size,
and "Change" / "Remove". Client-side checks mirror the server (type, 8 MB). On
submit the form sends `FormData` through `XMLHttpRequest` so the button can
read "Uploading photo… 43%" — a photo on a phone network is the slow part of
this form. A re-submission with a photo already on file says so and does not
require a new one. When `photo_upload` is false the old link field renders.

**`public/media-ops/index.html`**
- Request drawer: a `cast-photo` image above "Photo & profile" when
  `photo_file_id` is set; the Drive link button stays.
- Record drawer: the photo at the top of the body.
- Casting Preview card: the `.cast-thumb` shows the image instead of the
  "Media in Drive" placeholder when `photo_file_id` is set.
- Images use `loading="lazy"` and fall back to the placeholder on error.
- CSS for the photo lives in the main stylesheet (drawers open outside the
  casting views, where `castingStyles()` is not present). Markup for records
  without a photo is unchanged, so the desktop baseline is unaffected.

## Security

- The photo is personal data. It is never written under `/uploads` (publicly
  served); staging is a private temp dir and the file is unlinked on every path.
- Only raster image MIME types are accepted; the extension comes from the MIME.
- Streaming routes are behind the same authority as the data they show:
  requests → Casting Manager/Admin; records → the Preview visibility rule.
- The public endpoint touches Drive only after identity (OTP session or, on a
  link with verification off, the typed address), consent and field validation
  have passed — the same trust boundary the submit already has.
- Nothing about the Drive account reaches the browser: ids are opaque, links
  are only rendered through `safeExtUrl()`.

## Configuration (Google Cloud Console)

Shared with the Outreach video workflow — same credentials, one new folder id.

1. Google Cloud Console → a project → **APIs & Services → Library → Google
   Drive API → Enable**.
2. Choose one auth shape:
   - **OAuth refresh token** (recommended for "my Google Drive"): OAuth consent
     screen (User type *Internal* for the paruluniversity.ac.in Workspace, so the
     token does not expire after 7 days) → Credentials → OAuth client (Web
     application, redirect `https://developers.google.com/oauthplayground`) →
     in OAuth Playground tick *Use your own OAuth credentials*, authorise scope
     `https://www.googleapis.com/auth/drive` as the Casting Manager's account,
     exchange for a refresh token. Set `GOOGLE_OAUTH_CLIENT_ID`,
     `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`.
   - **Service account**: create one, download its JSON key, set
     `GOOGLE_SA_CLIENT_EMAIL` and `GOOGLE_SA_PRIVATE_KEY`. A service account has
     no storage quota of its own, so the folder below must be in a **Shared
     Drive** the account has Content-manager access to.
3. In Drive, create a folder (e.g. *Casting Registrations*), copy the id from
   its URL, set `GOOGLE_DRIVE_CASTING_FOLDER_ID`. With the service account
   shape, share the folder (or Shared Drive) with the service account's email.
4. Restart the API. `GET /public/casting/:token` now reports `photo_upload:
   true` and the form switches to upload.

Dev and tests: `DRIVE_LOCAL_ROOT=/some/dir` and nothing else — photos land in
`<dir>/casting-photos/<CR code>/`.

## Testing

- `server/casting-photos.test.ts` (unit, no DB): configured() truth table,
  extension from MIME, folder/file naming, local-mode storage round trip.
- `server/mediaops-casting-photo.integration.test.ts` (DB, local Drive
  adapter, real multer): multipart submit → 201, file on disk under the CR
  folder, row has Drive ids and `photo_url`; oversize → 400; wrong type → 400;
  no photo on first submit → 400; JSON submit with `photo_url` still works;
  manager streams the request photo (200, correct MIME), an employee gets 403;
  approve → record carries the photo and `drive_url` is the folder; the
  employee streams the record photo (consent confirmed) but not an archived
  record's.
- Existing suites unchanged: `mediaops-casting-otp.integration.test.ts` runs
  with Drive unconfigured and keeps posting `photo_url`.
- `npm run audit:media-ops`, `npm run typecheck`, `db-pool-safety` all pass.

## Out of scope (deliberately)

- The manual **Add casting** form in Casting Management still takes a Drive
  folder link; it is the Manager's own Drive and they already have the folder.
- Deleting a request does not delete its Drive folder — Drive is the archive.
- A per-campaign choice of which fields to ask for.
- Multiple photos per applicant.

## Decisions the Casting Manager should confirm

1. **Auth shape.** The spec recommends the OAuth refresh token so files are
   owned by the Casting Manager's own Workspace account in My Drive. If the
   university prefers a service account, a Shared Drive is required.
2. **Folder layout.** One folder per request code (`CR-00012`) directly under
   the configured root. Grouping by campaign is a one-line change if preferred.
3. **Re-submissions keep history** (new file beside the old one) rather than
   replacing the file in Drive.

---

## Part 2 — connecting Google Drive from the app (added the same day)

> Requested after Part 1: *"one dedicated button in Casting Management, only
> for the admin … it will ask us to sign in to my Google account … I'll select
> a Google Drive folder, or Drive can automatically create a folder."*

### What changes

An **Admin-only** button, **Google Drive**, beside *Add casting*, *Manage
tags* and *Manage categories* in Casting Management. Its dialog:

1. **Step 1 (once).** If no OAuth client is known, shows the four Cloud
   Console steps with the exact redirect URI to register, and takes the client
   id and secret. The environment's `GOOGLE_OAUTH_CLIENT_ID/_SECRET` are used
   instead when set, and the step is skipped.
2. **Step 2.** *Sign in with Google and connect Drive* opens a popup on
   Google's consent screen. The callback stores the refresh token and the
   account's email, then **creates "NERVE Casting Registrations" in that
   account's My Drive** (or keeps the previously configured folder if the
   account can see it). The popup tells the opener and closes; the dialog
   redraws as *Connected as … · Folder …*.
3. **Folder.** Paste a folder link to use one the Admin already has, or create
   another by name. **Check connection** asks Google whether the folder is
   still reachable. **Disconnect** revokes the token and forgets the account;
   the folder and the client are kept so reconnecting is one click.

The public form switches to *Upload photo* the moment a connection exists,
with no restart. An app connection takes precedence over the environment
(`GOOGLE_DRIVE_CASTING_FOLDER_ID`), which remains as the no-UI alternative.

### Architecture

```
Admin ─click─▶ POST /casting-drive/connect ─▶ { url: accounts.google.com/…?state=<signed> }
popup ─▶ Google consent ─▶ GET /casting-drive/callback?code&state
          verify state (HMAC, this admin, 10 min) → exchange code → userinfo
          → seal refresh token → mo_casting_drive → ensure folder → HTML popup
          → window.opener.postMessage({type:'nerve-casting-drive'}) → dialog refresh
casting-photos.ts resolve(): app connection → env → DRIVE_LOCAL_ROOT
```

**`server/casting-drive.ts`** — everything that talks to Google for this:
`castingDriveStatus`, `saveCastingDriveClient`, `castingDriveAuthUrl`,
`completeCastingDriveConnect`, `useCastingDriveFolder`,
`createCastingDriveFolder`, `checkCastingDrive`, `disconnectCastingDrive`,
`loadCastingDriveConnection` (what casting-photos needs), plus the pure parts
`parseDriveFolderId`, `signDriveState`/`verifyDriveState`,
`castingDriveRedirectUri`. Scope: `drive` + `userinfo.email` (`drive.file`
could not see a folder the Admin already has).

**`server/secret-box.ts`** — AES-256-GCM `sealSecret`/`openSecret`, key
derived from `SESSION_SECRET` and a purpose string; `v1.iv.tag.ct`. Rotating
`SESSION_SECRET` retires sealed values: `openSecret` returns null, the status
reads "not connected", the Admin reconnects.

**`mo_casting_drive`** — one row (`id = 1`): `oauth_client_id`,
`oauth_client_secret_enc`, `refresh_token_enc`, `account_email`, `folder_id`,
`folder_name`, `folder_url`, `connected_by`, `connected_at`, `updated_at`.

**`GoogleDriveClient`** takes optional `OAuthCredentials` so the connected
account's token is used instead of the environment's.

**`casting-photos.ts`** — `castingPhotosConfigured()` and the resolver are now
async; `castingPhotoSource()` reports `app | env | local | none`. A loader
failure (database hiccup) is not memoised. `useCastingDriveLoader()` is the
test seam.

**Routes** (all `isMoAdmin`, 403 otherwise): `GET /casting-drive`,
`POST /casting-drive/client`, `POST /casting-drive/connect`,
`GET /casting-drive/callback` (HTML), `POST /casting-drive/folder`
(`{folder}` or `{create}`), `POST /casting-drive/check`, `DELETE /casting-drive`.
Audit actions: `casting_drive.client_saved`, `.connected`, `.folder_changed`,
`.disconnected`.

### Security

- Admin only, not the Casting Manager duty: this is a credential for an outside
  account, and whoever holds it can see every applicant photo.
- `state` is HMAC-signed for the admin who pressed the button and expires in
  ten minutes; the callback also requires that admin's session (the cookie is
  `SameSite=Lax`, so Google's top-level redirect carries it).
- The refresh token never reaches the browser; the popup page carries only
  ok/message. Secrets are sealed at rest.
- The OAuth client from the environment is never overwritten from the app.

### Constraint to know

Google registers redirect URIs only for `https://` domains (plus `http://localhost`),
never a bare IP. `APP_BASE_URL` must be an https domain for the button to
work in production; the environment-only path has no such requirement.

### Testing

- `server/casting-drive.test.ts` — folder-link parsing, state signing,
  redirect URI, secret box.
- `server/mediaops-casting-drive.integration.test.ts` — the full round trip
  against a fake Google behind `globalThis.fetch`: authority, client saving,
  sign-in URL, callback refusals (bad state, other admin, non-admin, cancelled,
  bad code), successful connect with folder creation at My Drive root, upload
  through the connected Drive and stream back, folder by link / by creation,
  check, disconnect (revoke, folder kept) and reconnect (folder kept).
- `server/casting-photos.test.ts` — app connection precedence, non-memoised
  loader failure.
