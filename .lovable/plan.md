# Pending: SMS forwarder fix (commit 7fe761476c)

Nothing changes this turn. This is a standing instruction that only runs after commit 7fe761476c from PR #23 has been merged into lovable.

## When the commit is merged into lovable
1. Confirm 7fe761476c is an ancestor of the current lovable tip. Do not reset to an older lovable.
2. Take `supabase/functions/sms-forwarder-ingest/index.ts` exactly as that commit has it, with no rewrites.
3. Check that the file:
   - uses an upsert with `onConflict: "device_id,client_message_id"` and `ignoreDuplicates: true` (not `.insert()`)
   - still treats a leftover HTTP 409 or SQLSTATE 23505 as an ack
4. Redeploy only `sms-forwarder-ingest`, with verify_jwt left false.
5. Report the deploy result word for word.

## Will not change
- The unique constraint on (device_id, client_message_id)
- Any other file, function, migration or setting
