# AEGIS Dashboard

React 19 + Vite operator console for the AEGIS API. `server.js` serves the built output at `/app/` (the API's built-in `/dashboard` is a separate single-file page). The app is built with `base: '/app/'`, so the dev server runs at `/app/` too.

## Pages

Overview, Workflows (and workflow detail), Review Queue, DLQ, Traces, Anomalies, Billing, Tenants, Users, Audit log. Live metrics and workflows stream in over the API's `/events` SSE endpoint.

## Run

```bash
npm install
VITE_AEGIS_API_URL=http://localhost:3000 npm run dev
npm run build     # static output in dist/
npm run lint      # oxlint
```

If `VITE_AEGIS_API_URL` is unset, requests go to the page's own origin.

## Auth

The login screen offers **SSO** (enter your tenant ID → redirected to your identity provider) or an AEGIS **API key**. Either way the credential is verified against `GET /auth/me`, stored in `localStorage` (`aegis.apiKey`) and sent as `x-api-key`; the top bar shows who you are and your role. SSO sessions are short-lived (`AEGIS_SESSION_TTL_HOURS`, default 8) and revocable. SSO needs the server's `AEGIS_DASHBOARD_URL` set to this app's URL — see the root README. API keys are scoped to a tenant and a role.

## Structure

- `src/api/client.js` — fetch wrapper and API methods
- `src/context/` — Auth, Tenant, and SSE providers
- `src/pages/` — one file per route
- `src/components/` — shared UI (DataTable, StatCard, Badge, Sidebar, …)
