# Share

A personal, general-purpose shared expense tracker.

## Documentation

- [MVP architecture and SQLite schema](docs/mvp-architecture-and-schema.md)
- [System design interview study guide](docs/system-design-study-guide.md)
- [Database learning track](db/README.md)

## Database quick start

The first implementation milestone uses raw SQL so the relational design and its invariants remain visible before an ORM is introduced.

```bash
python3 scripts/migrate.py up
python3 -m unittest discover -s tests -v
```
