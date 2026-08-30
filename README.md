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

The initial learning API includes `POST /v1/users`, `POST /v1/groups`,
`POST /v1/groups/{group_id}/members`,
`GET/POST /v1/groups/{group_id}/expenses`,
`GET /v1/groups/{group_id}/balances`, and
`POST /v1/groups/{group_id}/settlements`.

Authentication is intentionally the next milestone. For now, the API accepts
IDs such as `actor_member_id` to make the domain services executable; these
IDs must come from a server-managed session before this is deployed.
