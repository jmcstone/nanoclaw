# Mailroom Rules Schema — Reference

Summary of the rule-engine schema for `~/containers/data/mailroom/rules.json` and `accounts.json`. The **canonical** schema doc is in the mailroom container at `src/rules/schema.md` (readable via `docker exec mailroom-ingestor-1 cat /app/dist/rules/schema.md`); this file is a nanoclaw-side digest for quick reference without docker-exec.

## File shapes

### `rules.json`

```jsonc
{
  "version": 1,
  "rules": [
    { "name": "docusign-urgent",
      "comment": "optional",
      "match": { "sender_contains": "docusign" },
      "actions": { "urgent": true } }
  ]
}
```

Array order = priority. Append broad rules first, narrow overrides at the bottom.

### `accounts.json`

```jsonc
{
  "version": 1,
  "accounts": [
    { "id": "gmail:jeff@americanvoxpop.com",
      "source": "gmail",
      "email": "jeff@americanvoxpop.com",
      "tags": ["work", "avp"] }
  ]
}
```

`id` must match the store's `account_id` (`<source>:<email>`). `tags` feed the `account_tag` predicate.

## Predicate leaves

Every string field accepts `string | string[]` with any-of semantics.

| Field | Target | Case |
|---|---|---|
| `sender_equals` / `sender_contains` | From-address | case-insensitive |
| `sender_matches` | From-address | case-sensitive regex (V8; no inline flags) |
| `subject_equals` / `subject_contains` | Subject | case-insensitive |
| `subject_matches` | Subject | case-sensitive regex |
| `body_contains` | Markdown body | case-insensitive |
| `body_matches` | Markdown body | case-sensitive regex |
| `has_label` | Labels at ingest | case-sensitive exact |
| `source` | `"gmail"` \| `"protonmail"` | enum |
| `account` | Account id | case-sensitive exact |
| `account_tag` | Account tag | case-sensitive exact |

**V8 regex caveat:** no `(?i)` or `(?i:...)` inline flags. Use `_contains` for case-insensitive substring; build case classes (`[Dd][Oo][Cc]`) for pattern-level folding.

## Combinators

`all: [...]` (AND), `any: [...]` (OR), `not: {...}` (negate). Edge cases:

- `all: []` matches (vacuous AND)
- `any: []` does **not** match (vacuous OR is false)
- `not: {}` does **not** match (negates vacuous-true empty predicate)
- Empty `{}` predicate matches everything (useful for a trailing catch-all rule)

Leaf fields and combinators on the same predicate object are AND-ed.

## Actions

```jsonc
{
  "urgent": true,
  "auto_archive": false,
  "qcm_alert": false,
  "label": "Tax",
  "add_label": ["Receipts"],
  "remove_label": "Newsletter"
}
```

- **Scalars** (`urgent`, `auto_archive`, `qcm_alert`): last-writer-wins across the rule array.
- **Label primitives** operate on two disjoint accumulators (`labels_to_add`, `labels_to_remove`):
  - `label X` → `to_add = {X}`, `to_remove -= X`
  - `add_label X` → `to_add += X`, `to_remove -= X`
  - `remove_label X` → `to_remove += X`, `to_add -= X`
- **Conflict resolution**: if both `urgent: true` and `auto_archive: true` end up set, `urgent` wins and `auto_archive` is forced false.

## Event delivery

- `urgent: true` → `inbox:urgent` event (immediate Madison spawn)
- `urgent: false` + `auto_archive: false` → `inbox:routine` event (normal polling-window spawn)
- `urgent: false` + `auto_archive: true` → **no event** (silent label + archive; Madison sees in morning FYI only if at all)

## Validation

```sh
docker exec mailroom-ingestor-1 node dist/cli/rules-validate.js
```

Emits JSON on stdout; exits 0 if both files valid, 1 if either fails, 2 on bad CLI usage. Errors carry a `doc_path` like `rules[2].match.all[1].subject_matches` pointing at the exact offending key.

## Related

- [../infrastructure/mailroom-rules.md](../infrastructure/mailroom-rules.md) — engine architecture
- [../infrastructure/madison-pipeline.md](../infrastructure/madison-pipeline.md) — event delivery path
- Canonical: `mailroom/src/rules/schema.md` (deeper examples + common patterns)
