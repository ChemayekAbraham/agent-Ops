# 190 — Staff user search now resolves a Welile ID

**Date:** 2026-10-02 · **Scope:** `supabase/migrations/20261002150000_search_users_fast_welile_id.sql` (RPC only, no frontend change, no edge function)

## Problem
Financial Ops (User Wallet Statements, wallet move, float credit, bucket transfer, etc.) could not
find a user by Welile ID (`WEL-1A2B3C`). Every one of those pickers calls `search_users_fast`, which
knew UUID, phone, national ID, email and name — not the Welile ID. Worse, `WEL-123456` contains six
digits, so the phone branch swallowed it and returned nothing.

## Fix
The Welile ID is derived, not stored: `'WEL-' || upper(first 6 hex chars of profiles.id)`
(`derive_welile_ai_id`). `search_users_fast` gets a new first branch that matches
`^WEL[-\s]?[0-9a-f]{6}$` (case-insensitive, dash/space optional) and resolves it as a UUID range scan
on the primary key (`id >= hex||'00-…'` and `id <= hex||'ff-…'`). It runs **before** the phone branch.
All other branches are the live body, unchanged (verified against production 2026-10-02 before writing).

## Notes
- Six hex chars can collide across users; all matches are returned (limit 50) so the operator picks.
- Verified read-only against production: a sampled ID returned exactly the rows
  `derive_welile_ai_id` expects (1 / 1).
- Placeholder copy in the pickers still says "name or phone" — a UI-copy change for Gemini.
- No `docs/HANDOVER/architecture-map.html` change: the map has no node for this RPC's matching rules.

## Verify after the migration is applied
Search a known user's `WEL-XXXXXX` in Financial Ops → User Wallet Statements: that user appears.
Check `pg_get_functiondef('public.search_users_fast'::regproc)` contains the `WEL` branch.
