# Stage 11 / Stage 12 reconstruction

The Stage 11 register (`fin_collection_reconciliation_s11`, 659 collections, UGX 56,946,270) is a
frozen investigation snapshot. Its rows were loaded as data on 2026-10-02 from a read-only analysis
of `fin_correction_review_items` (non-test rows) joined to `agent_collections`, `rent_requests`,
`profiles` and `general_ledger`. Recomputing it later would give different answers as live data
changes, so the snapshot itself is kept here.

| File | Purpose |
| --- | --- |
| `original_0422_stage11_collection_reconciliation_report.sql` | Byte-exact copy of the original Stage 11 migration from commit `ae24976f6a` (md5 `35345b583c10d588a291d28760915e4f`). Already applied to the live database. |
| `fin_collection_reconciliation_s11.csv` | Exact export of all 659 live rows (sha256 `cbd81e992f20be285d13954aa6901eb98d3a3eed6b4c2d598af0def496d9801c`). |
| `rebuild_stage11_stage12.sql` | Idempotent loader for a fresh database: loads the 659 rows, creates the 659 Pending Evidence Stage 12 rows, verifies 659 / UGX 56,946,270. On a populated database it only verifies. |

## Fresh rebuild order

1. Apply `original_0422_stage11_collection_reconciliation_report.sql` (table + read function).
2. Apply the Stage 12 migration (`drizzle/migrations/0422_stage12_collection_evidence_resolution.sql`)
   and later Stage 12 migrations. On an empty Stage 11 table its seeding step copies 0 rows.
3. Run `rebuild_stage11_stage12.sql`.

## Migration numbering

The original Stage 11 migration was numbered `0422` on the `lovable-backup-lovable-1790946015`
branch. That history was replaced by a GitHub push, and the Stage 12 migration was then assigned
`0422` on the active branch. The Stage 11 SQL is kept here rather than re-registered in the Drizzle
journal, because it is already applied live and re-registering it would make the migrator try to
create the existing table again. Do not merge the backup branch's `0422_stage11...` journal entry
into `lovable`: it would create a second `0422`.

The CSV contains agent and tenant names. Keep this repository private.
