# Finance Management — Backend Upload Service

Implements the workflow in `finance_management_architecture.md` section 5,
against the schema in `finance_management_schema_v2.sql`.

## Files

- `uploadProcessor.js` — core logic, framework-agnostic. Fully implemented:
  file parsing/validation, fund_quarter resolution, Drive upload + hash
  dedup, staging, classification (new/duplicate/unknown_emis/invalid),
  preview counts, and commit (insert new + audited update of confirmed
  duplicates + quarter total recompute).
- `routes/uploadRoutes.js` — example Express wiring showing the 3-call
  frontend sequence: `check-quarter` → `upload` (validate+stage+preview)
  → `commit`. Swap Express for Cloudflare Worker/Vercel/Apps Script as
  needed; the processor functions don't care what calls them.
- `driveFolders.js` — **not included yet**, referenced by the route
  example (`getOrCreateDriveFolder`). This needs your Drive service
  account credentials to actually test against, so I stubbed the import
  rather than guess at your folder-caching approach. Say the word and
  I'll write it — it's a straightforward recursive
  find-or-create-by-name using the Drive v3 API, caching the resolved
  quarter folder id back onto `fund_quarters.drive_folder_id`.

## Environment variables required

```
SUPABASE_URL=https://qotwsxkgjfdwfwpnhwjx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...        # service role — server only, never in frontend
DRIVE_SERVICE_ACCOUNT_EMAIL=...
DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY=... # keep \n escaped if stored as one line
```

Get the Supabase values from Project Settings → API in your dashboard
(`qotwsxkgjfdwfwpnhwjx`). The Drive service account needs to be shared
with (or own) the "Finance Management" Drive folder tree.

## Install

```bash
npm install @supabase/supabase-js xlsx express multer googleapis
```

## What's still needed before this is deployable

1. `driveFolders.js` (find-or-create folder helper) — see above.
2. `requireSession` in `uploadRoutes.js` is a stub — wire it to your
   existing personnel-number/CNIC session check so `req.user` is populated.
3. A decision on hosting (Cloudflare Worker / Vercel / Apps Script relay)
   — the route file assumes Express/Node; I can rewrite it for whichever
   you pick.
4. The `schools` table needs to be seeded before any upload can classify
   rows as `new` (everything will show as `unknown_emis` until then).

## Not yet built

- Frontend (GitHub Pages) upload screen, dashboard, and school search —
  next after the above.
- Monthly expense entry endpoints — same CRUD pattern as `uploadProcessor.js`,
  straightforward to add once you confirm the backend hosting choice.
