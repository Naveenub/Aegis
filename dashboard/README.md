# AEGIS Dashboard

React 19 + Vite operator console for the AEGIS API. It is a standalone app; `server.js` does not serve it (the API's built-in `/dashboard` is a separate single-file page).

## Pages

Overview, Workflows (and workflow detail), Review Queue, DLQ, Traces, Anomalies, Tenants. Live metrics and workflows stream in over the API's `/events` SSE endpoint.

## Run

```bash
npm install
VITE_AEGIS_API_URL=http://localhost:3000 npm run dev
npm run build     # static output in dist/
npm run lint      # oxlint
```

If `VITE_AEGIS_API_URL` is unset, requests go to the page's own origin.

## Auth

The login screen takes an AEGIS API key, verifies it against `GET /tenants`, and stores it in `localStorage` (`aegis.apiKey`). Keys are sent as `x-api-key`. Use a key scoped to the tenant you want to view.

## Structure

- `src/api/client.js` — fetch wrapper and API methods
- `src/context/` — Auth, Tenant, and SSE providers
- `src/pages/` — one file per route
- `src/components/` — shared UI (DataTable, StatCard, Badge, Sidebar, …)
