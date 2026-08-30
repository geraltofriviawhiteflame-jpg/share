# Mobile web client

The client lives in `src/ui` as four hand-written files (`index.html`,
`styles.css`, `app.js`, `manifest.webmanifest`) plus `icon.svg`. It is served by
the same `node:http` server at `/`, so opening the API origin on a phone is the
whole installation step. `npm run build` copies it into `dist/ui`; in
development the handler reads it straight from `src/ui`.

## Why no framework

The point of this repo is that the schema, the transactions, and the HTTP
adapter stay readable. A bundler, a component tree, and a state library would
add three things to learn without adding one behaviour. So the client is one
`state` object, one `render()` per screen, and event delegation on
`data-act` / `data-field` attributes. `src/http/ui.ts` serves the files with a
strict CSP (`default-src 'self'`, no inline script or style attributes), which
is affordable only because nothing is inlined.

## What the screens map to

| Screen | Calls |
| --- | --- |
| Pick or create a person | `GET /v1/users`, `POST /v1/users` |
| Group list with your net position | `GET /v1/groups?user_id=`, `GET /v1/groups/{id}/balances` |
| Balances tab | `GET /v1/groups/{id}/balances` |
| Activity tab | `GET /v1/groups/{id}/expenses`, `GET /v1/groups/{id}/settlements` |
| People tab | `GET /v1/groups/{id}/members` |
| Add expense | `POST /v1/groups/{id}/expenses` |
| Record settlement | `POST /v1/groups/{id}/settlements` |
| Add person | `POST /v1/groups/{id}/members` |

Balances and the ledger are computed by the server. The client never adds,
subtracts, or rebalances amounts on its own: it only reads.

Two deliberate choices are worth being able to defend:

- **The split preview mirrors the server.** An equal split of integer paise
  cannot be exact, so `ExpenseService.prepareShares` sorts member ids and hands
  each leftover paisa to the first few participants. The client reproduces that
  ordering purely to describe the outcome ("₹400.01 for 1 person"), because a
  preview that disagrees with the stored result is worse than no preview. The
  server remains the authority; the preview is checked again on write.
- **Drafts hold field text, not parsed numbers.** Sheets render from
  `state.sheet.draft`, and every field writes back the raw string the user
  typed. Re-rendering a sheet for a chip tap therefore cannot rewrite a value
  under the caret, and there is exactly one conversion point (`toPaise`)
  between text and paise. An earlier version stored filled-in shares as paise
  and converted again while rendering, which displayed ₹50.25 as ₹0.50 — a bug
  the click-through driver caught and a reason the conversion is one-way.

## Identity without authentication

Authentication is still the project's next milestone, and the API trusts IDs
such as `actor_member_id`. The client keeps `{ userId }` and the last opened
group in `localStorage` and sends them as the actor on every write; there is no
token, no cookie, and no server-side session. That is a development affordance,
not a design: anyone on the network can act as anyone else until sessions
exist, which is why the README keeps the deployment warning.

Because the roster and the user list were write-only, three read endpoints were
added for the client: `GET /v1/users`, `GET /v1/groups/{group_id}/members`, and
`GET /v1/groups/{group_id}/settlements`. They are plain reads over existing
tables — no schema change, no new invariant — and the OpenAPI document and
`src/services/roster.test.ts` / `src/http/server.test.ts` cover them.

## Trying it out

```bash
npm run dev          # serves the app and the API on 0.0.0.0:8080
npm run db:seed-demo # optional demo group, written through the API
```

`scripts/seed-demo.mjs` uses HTTP rather than the SQLite file on purpose: the
running server owns the file, and a second writer would lose work. On a phone,
use the browser's **Add to Home Screen** — the manifest requests standalone
display, and the layout already respects `env(safe-area-inset-*)`.

## Known gaps

- No editing or deleting: `PATCH`/`DELETE` on expenses and settlements are not
  implemented, so a mistake is corrected with a compensating entry.
- Leaving a group (`status = 'left'`) is in the schema and the roster view, but
  no endpoint writes it yet.
- `simplify_debts` is stored and shown, but `BalanceService` always returns the
  greedy suggestion, so the switch does not change anything yet.
- Multi-currency, invitations, offline queueing, and push are untouched.
