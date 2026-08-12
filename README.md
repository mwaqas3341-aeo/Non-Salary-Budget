# Finance Management System — Setup Package

Extract this zip, then follow the steps below **in order**.

## 1. Supabase SQL Editor
Open your project's SQL Editor (qotwsxkgjfdwfwpnhwjx) and run the files in
`sql/` in numeric order — copy/paste each one's content and run it:

1. `01_drop_unrelated_tables.sql` — removes tables not part of this system
2. `02_finance_management_schema.sql` — rebuilds all finance tables clean,
   seeds NSB fund + FY 2025-26
3. `03_add_area_column.sql` — adds the `area` column schools import needs

(`00_list_tables_optional.sql` is just a diagnostic query — only run it if
you want to see what's currently in the project; not required.)

## 2. Supabase Table Editor (not SQL Editor)
Go to Table Editor → `schools` table → Insert → **Import data from CSV** →
upload `data/schools_import.csv`. Do this *after* step 1.3 above, or the
import will fail on the missing `area` column again.

## 3. Backend — new GitHub repo, deployed on Render
Create a **new, separate** GitHub repo (e.g. `finance-backend`) and copy
everything from the `finance-backend/` folder into it, keeping the same
structure:

```
finance-backend/
├── package.json
├── .env.example
├── server.js
├── uploadProcessor.js
├── routes/
│   └── uploadRoutes.js
└── README.md
```

Push it, then on render.com: New → Web Service → connect that repo. Render
auto-detects Node and runs `npm install && npm start`. In Render's
dashboard, fill in the real values for the env vars listed in
`.env.example` (Supabase service role key, Drive credentials, your GitHub
Pages URL). You'll get a live URL like `https://finance-backend.onrender.com`.

This does **not** go in your GitHub Pages frontend repo — Pages can't run
server code.

## 4. Reference
`docs/finance_management_architecture.md` — full workflow explanation
(Drive folder structure, upload processing steps, storage estimates,
testing checklist). Read when you need the "why," not required to deploy.

## Still outstanding (not in this package yet)
- `driveFolders.js` — needs your Google Drive service account before I can
  write it
- GitHub Pages frontend (upload screen, dashboard, school search)
