# Share

A personal, general-purpose shared expense tracker.

The project is deliberately built as an interview practice exercise: the
relational schema is the source of truth, money is integer paise, and financial
mutations are transactional. The backend is a TypeScript modular monolith over
SQLite.

## Documentation

- [MVP architecture and SQLite schema](docs/mvp-architecture-and-schema.md)
- [TypeScript backend study guide and interview questions](docs/typescript-backend-study-guide.md)
- [System design interview study guide](docs/system-design-study-guide.md)
- [Database learning track](db/README.md)
- [Mobile web client](docs/mobile-client.md)

## Database quick start

The original schema milestone uses raw SQL so the relational design and its
invariants remain visible before an ORM is introduced.

```bash
python3 scripts/migrate.py up
python3 -m unittest discover -s tests -v
```

## TypeScript API quick start

Node.js 20 or newer is recommended.

```bash
npm install
npm test
npm run build
npm start
```

The server binds to `0.0.0.0:8080` by default. You can configure it with:

```bash
PORT=8080 DATABASE_FILE=data/share.db npm start
```

The API applies pending SQL migrations at startup. Check it with:

```bash
curl localhost:8080/healthz
```

Interactive API documentation is available at:

```text
http://localhost:8080/docs
```

The Swagger UI includes sample request bodies for user creation, group/member
setup, equal and exact expense splits, balance lookup, and settlements. Use
**Try it out** to execute requests against the running local server. The raw
OpenAPI document is available at `http://localhost:8080/openapi.json`.

The learning API includes `GET/POST /v1/users`, `GET/POST /v1/groups`,
`GET/POST /v1/groups/{group_id}/members`,
`GET/POST /v1/groups/{group_id}/expenses`,
`GET /v1/groups/{group_id}/balances`, and
`GET/POST /v1/groups/{group_id}/settlements`.

## Mobile app

The same server also serves a phone-sized web client at the origin root, with no
build step and no framework:

```text
http://localhost:8080/
```

Open it on a phone (or resize the browser) and you can create a person, start a
group, add people, record equal or exact expenses, watch balances re-derive from
the ledger, and settle up. Use **Add to Home Screen** for a standalone window.

To see it populated, seed a demo group through the API:

```bash
npm run dev          # terminal 1
npm run db:seed-demo # terminal 2
```

The client stores which person is holding the device in `localStorage` and sends
that membership as `actor_member_id`; see
[mobile client notes](docs/mobile-client.md) for why, and for what it does not
do yet (no edit, no delete, no leaving a group).

Authentication is intentionally the next milestone. For now, the API accepts
IDs such as `actor_member_id` to make the domain services executable; these
IDs must come from a server-managed session before this is deployed.
