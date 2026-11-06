-- v_staff_assistant_crm_messages_redacted is a deliberate security-definer gate: only a CRM reviewer who passes
-- staff_assistant_crm_can_review() and staff_mfa_ok() sees other staff's questions (replies blanked), while the table's
-- own policy lets each person read only their own messages. Do NOT switch it to security_invoker (the Supabase advisor
-- suggestion): reviewers would then see only their own rows and the feature would break.
-- The real gap: migration 20261027100000 granted SELECT, but Supabase's default privileges had already given
-- authenticated INSERT/UPDATE/DELETE/TRUNCATE on the new view. The view is auto-updatable and runs as its owner, so a
-- reviewer could have changed or deleted other staff's assistant messages through it although the table itself grants
-- authenticated no write. Reduce authenticated to SELECT. Applied to production by hand; this file is the record.
revoke insert, update, delete, truncate, references, trigger on table public.v_staff_assistant_crm_messages_redacted from authenticated;
