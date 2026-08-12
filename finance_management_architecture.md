# Finance Management System — Architecture & Workflow

Companion to `finance_management_schema.sql`. Read that file's inline comments
alongside this doc — the schema is the source of truth for field names.

## 1. Layer responsibilities (recap)

| Layer | Holds |
|---|---|
| Supabase (Postgres) | financial years, funds, quarters, school-quarter amounts, expenses, upload metadata, audit logs |
| Google Drive | original xlsx/csv/pdf files, scanned vouchers |
| Google Sheets | one consolidated export sheet for reporting, rebuilt/synced from Supabase — never edited as a source of truth |
| GitHub Pages | frontend only; static config/dropdowns as JSON |
| Backend/service layer | the only place holding the Supabase `service_role` key and Drive service-account credentials — never in frontend JS |

Since your existing stack (A-I-DB, PSMS, AEO Schools Portal) is Apps-Script-backed
rather than Supabase-backed, this project introduces Supabase as a new dependency.
The `schools` table in the SQL file is a fresh Supabase table meant to be seeded
once from your existing EMIS master list (export to CSV/JSON, bulk `insert`), then
kept as the canonical reference for this app going forward.

## 2. Backend/service layer

Because Google OAuth is excluded and credentials can't sit in GitHub Pages JS, all
Drive writes and any Supabase write needing elevated privilege go through one
small backend function (Cloudflare Worker / Vercel function / a lightweight Apps
Script Web App acting purely as a relay — whichever fits your hosting comfort
level). This function:
- Holds the Drive service-account key and Supabase `service_role` key.
- Exposes a few narrow endpoints: `uploadQuarterFile`, `commitStagedRecords`,
  `getSignedDownloadUrl`, `exportConsolidatedSheet`.
- Authenticates the caller using your existing personnel-number/CNIC session
  token, then applies jurisdiction filtering itself before touching Supabase.

The GitHub Pages frontend talks to Supabase directly (via `anon` key + RLS, or
via this backend) for **reads**, and always through the backend for **writes**
that touch Drive or need elevated trust (uploads, corrections).

## 3. Google Drive folder structure & provisioning

```
Finance Management/
  2025-26/
    NSB/
      Q1/
        Original/
        Additional/
        Corrected/
      Q2/ Q3/ Q4/
    Other Funds/
  2026-27/
    ...
```

On each upload, the backend:
1. Looks up (or creates) the `<year>/<fund>/<quarter>/<upload_type folder>` path,
   caching folder IDs in `fund_quarters.drive_folder_id` so it's a lookup after
   the first time, not a fresh Drive traversal every upload.
2. Computes a SHA-256 hash of the file and checks `drive_files.file_hash` —
   if it matches, reject as an exact duplicate file upload before it ever
   reaches Drive.
3. Uploads to the resolved folder, gets back a `google_drive_file_id`.
4. Inserts one `drive_files` row, then one `fund_uploads` row referencing it.

## 4. File naming convention

Standardized name generated server-side; the user's original name is kept in
`fund_uploads.file_name`/`drive_files.original_file_name`:

```
<FUND>_<YEAR>_<QUARTER>_<Type>_<UploadDateISO>.<ext>
NSB_2025-26_Q1_Initial_2026-08-12.xlsx
NSB_2025-26_Q1_Additional_2026-11-15.xlsx
NSB_2025-26_Q1_Correction_2026-12-01.xlsx
```

## 5. Upload processing workflow (maps to schema section 12)

1. **Validate file** — required columns present (EMIS, school, amount, quarter,
   year, fund); reject blank rows outright.
2. **Resolve fund_quarter** — `financial_year_id + fund_id + quarter`. If it
   doesn't exist, create it (this becomes `upload_type = 'initial'`). If it
   exists, prompt: *"Q1 for NSB, FY 2025-26 already exists — upload as
   Additional or Correction?"*
3. **Stage rows** — insert parsed rows into `fund_upload_staging` tied to the
   new `fund_uploads.id`.
4. **Classify each staged row** using the query pattern in schema section 12:
   `new` / `duplicate` / `unknown_emis` / `invalid`.
5. **Preview screen** — counts per classification, so the officer sees e.g.
   "1,420 existing, 80 new, 3 unknown EMIS" before committing anything.
6. **Confirm** — on confirm:
   - `new` rows → insert into `fund_school_quarterly`.
   - `duplicate` rows → left untouched unless the officer explicitly opts to
     update specific ones, in which case write old+new values to `audit_logs`
     (`action = 'correction'`) before updating.
   - `unknown_emis`/`invalid` rows → reported back, never inserted.
7. **File already saved to Drive** in step where the upload was first accepted
   (section 3) — no separate save step needed here.
8. **Update `fund_uploads`** row with final `records_inserted`,
   `records_updated`, `duplicate_records`, `error_records`,
   `processing_status = 'committed'`.
9. **Recompute `fund_quarters.total_amount`** as `sum(received_amount)` for
   that quarter and update `file_status` (`partial` if it looks incomplete
   relative to total active schools, `complete` otherwise — a heuristic your
   admin can override manually).

This is exactly the "late Q1 file" case in section 28 of your spec: the second
file becomes an `additional` upload against the *same* `fund_quarters` row; its
80 new schools insert cleanly under the unique `(fund_quarter_id, school_id)`
constraint, and any of the 1,420 already-present schools it also happens to
list are flagged `duplicate` and left alone unless corrected explicitly.

## 6. Google Sheet sync (reporting only)

One workbook, one tab per fund (or one tab total with a Financial Year column
as in your example) rebuilt by a scheduled job or an "Export" button:
`Financial Year | EMIS | School | Fund | Quarter | Amount`. The job truncates
and rewrites rather than appending, so it can never drift from Supabase or
accumulate duplicate rows. Never treat the sheet as writable by users.

## 7. Storage estimate (free-tier check)

Rough per-row sizes (Postgres, including indexes) at 1,500 schools:

| Table | Rows/year | Est. size/year |
|---|---|---|
| `fund_school_quarterly` | ~6,000 | well under 5 MB |
| `monthly_expenses` (avg 2/school/month) | ~36,000 | a few MB |
| `fund_uploads` + `drive_files` | dozens–low hundreds | negligible |
| `audit_logs` | grows with corrections only | monitor, archive after 2 FYs |

Even 5+ years of this stays a small fraction of Supabase's free-tier 500 MB
database limit, provided no files/blobs are ever stored in Postgres (they
aren't, by design — everything binary lives in Drive). Build a small admin
page that runs `select pg_database_size(current_database())` periodically
and warns above ~70% of the plan limit.

## 8. Roles / access model

Admin, District Finance User, Tehsil User, Markaz User, School User, Read Only
— mirrors your existing jurisdiction pattern (District → Wing → Tehsil →
Markaz). Enforced either via Supabase RLS keyed off a self-issued JWT, or via
the backend service layer filtering by the caller's session-declared
jurisdiction before querying (see schema section 13 for the trade-off — given
your stack's history of backend-mediated access rather than Supabase Auth,
the backend-filtering approach is the smaller lift).

## 9. Testing checklist (maps to spec section 30, items 14–20)

- [ ] Load ~1,500 synthetic schools + 4 quarters of NSB data; confirm dashboard
      aggregate queries stay fast (should hit the `fn_dashboard_summary` RPC,
      not row-by-row frontend loops).
- [ ] Upload the same file twice unmodified → rejected as duplicate via
      `drive_files.file_hash` uniqueness.
- [ ] Upload initial Q1 (1,420 schools), then a late Q1 file with 80 new +
      some overlapping schools → overlapping flagged `duplicate`, 80 insert
      cleanly, `fund_quarters` unique constraint never violated.
- [ ] Attempt a correction on an existing `fund_school_quarterly` row without
      going through the audited update path → should be blocked by app logic
      (DB itself allows the update; the audit trail is an application-level
      guarantee enforced by always writing `audit_logs` in the same
      transaction as any correction).
- [ ] Fire two uploads for the same quarter concurrently → Postgres unique
      constraints (`uq_fund_quarter`, `uq_fund_quarter_school`) prevent
      duplicate rows even under a race.
- [ ] Confirm financial years stay isolated — querying FY 2025-26 never
      returns FY 2026-27 rows (all queries filter by `financial_year_id`).
- [ ] Confirm every original uploaded file remains retrievable in Drive after
      an additional/correction file is uploaded later (`fund_uploads` rows
      are never deleted, per section 7).

## 10. Open items I need from you before implementation starts

1. Confirm there is no existing Supabase project/schema for this system yet
   (my assumption above) — if one exists, share its `schools` table DDL so I
   reference it instead of the one in the SQL file.
2. Confirm the backend hosting choice for the service layer (Cloudflare
   Worker, Vercel, a lightweight Apps Script Web App, or something else you
   already run) — this determines how I wire the Drive/Supabase credentials.
3. Confirm the auth/session mechanism you want RLS or the backend to key off
   (personnel-number token, CNIC, or your existing AEO Portal session
   format) so jurisdiction filtering matches your other apps.
