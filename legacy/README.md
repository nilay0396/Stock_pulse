# Legacy Code

The live application is the Netlify/Supabase stack:

- `frontend/` React app
- `netlify/functions/` API, Kite auth, pipeline, report delivery
- `supabase/migrations/` database schema
- `.github/workflows/` scheduled and manual report generation

Older Python/FastAPI/Mongo code is kept here only as historical reference. It is
not part of the deployed production path.
