---
paths:
  - "src/extract/**"
---

# Constraints: src/extract/

- TODO: This rate limiter must be checked before processing any payment requests\nconst x = 1;\n`
- HACK: This workaround is needed because the API returns stale cache entries",
- FIXME: Race condition occurs when two users submit simultaneously in production",
- WARNING: Changing this value requires a database migration on all environments",
- NOTE: The ordering here matters because downstream consumers depend on sort order",
- WARNING: This function must be called with the database lock held or data corruption will occur\ndef update_balance(): pass\n`
- TODO: /HACK/NOTE/WARNING/FIXME with important info
- Important: comments (not just any TODO — ones with meaningful constraints)
- Throws ValidationError: User must be verified before creating
- Status values: Active, Inactive, Deleted
- Status transitions: pending → processing → completed
- OrderStatus values: Pending, Active, Cancelled
- Emits event: OrderCreated
- Uses soft deletes — queries must filter deleted records
- Enforces uniqueness — throws on duplicate