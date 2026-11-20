# DigiKavach

DigiKavach is a Next.js and Supabase web app for civilian safety and police case management. Civilians file and track complaints; officers triage them with AI assistance.

## Features

**Civilian portal**
- Sign up / log in, file complaints with evidence uploads (private storage)
- AI-assisted complaint extraction and a safety-assistant chat
- Track complaint status; SOS alerts and a Call 112 button
- Public safety map; bilingual UI

**Officer portal**
- Case dashboard with search, filters, stats and notes
- Case detail tabs, case linking and a case web (graph) view
- Dossiers, camera/image intelligence, BNS legal section suggestions
- Realtime SOS alerts and status updates

## Tech stack

Next.js (App Router), React, TypeScript, Tailwind CSS, Supabase (Auth, Postgres with RLS, Storage, Realtime), Google Gemini with Groq fallback, Leaflet, TensorFlow.js (COCO-SSD).

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in values
npm run dev
```

Open http://localhost:3000.

### Environment variables

See [.env.example](.env.example). `NEXT_PUBLIC_*` values are safe to be public; all others are secrets and must never be committed.

### Database

1. Create a new project at https://supabase.com.
2. Open **SQL Editor**, paste the contents of `supabase/schema.sql`, and run it. This creates tables, RLS policies, the evidence storage bucket and realtime publication.
3. Copy the project URL and anon key into `.env.local`.

`supabase/reset-data.sql` clears data and is for development only.

### Creating officer accounts

Public signup always creates a `civilian`. To create an officer:

1. Create the user in Supabase **Authentication -> Users** (or sign up once via the civilian form).
2. In the SQL Editor run:
   ```sql
   update public.profiles set role = 'officer' where email = 'officer@example.com';
   ```
3. Log in at `/officer/login`.

## Deploy

Import the repo into Vercel and add the variables from `.env.example` (except `SUPABASE_SERVICE_ROLE_KEY`) under Settings -> Environment Variables.

## Scripts

- `npm run dev` - development server
- `npm run build` / `npm start` - production build and serve
- `npm run lint` - ESLint
