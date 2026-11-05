# Family Document Vault

A premium family document management application built with React, Vite, Tailwind CSS, and Supabase-ready architecture.

## Features

- Shared family login flow
- Responsive dashboard and sidebar layout
- Member profile management
- Member-specific and common family document storage
- Passport manager with expiry tracking
- Global search across documents and profiles
- Important document highlighting
- Supabase-backed family, member, document, and passport records
- Private Supabase Storage uploads for documents, profile photos, and passport images
- Realtime updates across signed-in clients
- Local demo persistence when Supabase credentials are not configured

## Run locally

```bash
npm install
npm run dev -- --host 0.0.0.0
```

Visit http://localhost:5173

## Deploy to Render

Create a **Static Site** on Render using this repository. The included `render.yaml` configures the build (`npm ci && npm run build`), publishes `dist`, and rewrites app routes to `index.html`. Static sites do not need a port setting; `5173` is only Vite's local development port.

Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the Render service's environment settings before deploying. These values are used during the build. Use only a Supabase publishable/anon key in the frontend; never add a secret or service-role key.

## Supabase setup

Copy `.env.example` to `.env` and fill in your environment values:

```bash
cp .env.example .env
```

Then set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

In the Supabase SQL Editor, run `supabase/schema.sql` to create/update the tables, row-level security and storage policies, private `family-documents` bucket, and Realtime publication. The app creates a family row for the signed-in user if one does not already exist.

When configured, the app loads and saves family members, documents, passports, and uploaded files directly to Supabase. Failed saves are shown in the app's sync status and can be retried. The browser-local demo store is only used when Supabase credentials are not configured.

If Storage reports `new row violates row-level security policy`, rerun the latest `supabase/schema.sql` in the SQL Editor. Uploads use the private `family-documents` bucket and owner-scoped paths. Member/common document uploads support PDFs up to 100 MB and images up to 25 MB; passport scans and profile photos support images up to 25 MB. Files larger than 6 MB use resumable uploads to better handle mobile and unstable network connections. The bucket limit is 100 MB, so image uploads are limited by the app to 25 MB. Set the Supabase project's global Storage file-size limit to at least 100 MB as well.

Deleting a document permanently removes its database record and attempts to remove its file from the private Storage bucket.

## Notes

The current implementation runs in a secure local demo mode when Supabase credentials are not configured, so the app remains usable without real backend keys.
