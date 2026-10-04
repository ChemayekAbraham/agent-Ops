-- Step D (structural hardening only -- item 2). Independent of the
-- category audit in item 1, which is a separate report requiring
-- business-intent sign-off before any category list changes.
--
-- wallet_route_for_category exists as two live, coexisting overloads:
--   wallet_route_for_category(text, text)        -- category+direction only
--   wallet_route_for_category(uuid, text, text)   -- also checks agent role,
--                                                     redirects specific
--                                                     categories to float,
--                                                     falls through to the
--                                                     2-arg version otherwise
-- Every current authoritative caller (create_ledger_transaction, the
-- projection recompute in refresh_wallet_projection_for /
-- v_user_wallet_strict) correctly uses the 3-arg version, so nothing is
-- misrouting money today. But the 2-arg overload has never had its
-- EXECUTE privilege revoked from PUBLIC (Postgres grants EXECUTE on new
-- functions to PUBLIC by default unless explicitly revoked, and no prior
-- migration ever did so for either overload) -- so it remains directly
-- callable by any anon/authenticated client via
-- supabase.rpc('wallet_route_for_category', {p_category, p_direction}),
-- silently skipping the agent-role check. This exact bug class already
-- shipped once: migration 20260515113611_a78dae5e-607a-4e4a-ad99-0760db81e681.sql
-- had to remove 'wallet_transfer' from the agent-redirect list after
-- person-to-person transfers were wrongly landing in float for agent
-- recipients.
--
-- This migration only revokes access and documents intent. It does not
-- touch either function's body or the agent-redirect category list.

REVOKE ALL ON FUNCTION public.wallet_route_for_category(text, text) FROM PUBLIC;

COMMENT ON FUNCTION public.wallet_route_for_category(text, text)
  IS 'INTERNAL BASE ROUTING LOGIC ONLY (category+direction, no agent-role check). EXECUTE revoked from PUBLIC/anon/authenticated/service_role as of 2026-08-11 (Step D). The 3-arg overload wallet_route_for_category(uuid, text, text) is the correct entry point for any new caller: it checks the agent role first for a specific redirect-to-float category list, then falls through to this function for everything else. Calling this 2-arg version directly skips that agent-role check entirely -- exactly the bug class that already shipped once (wallet_transfer wrongly routed to float for agents, fixed 2026-05-15, migration 20260515113611_a78dae5e-607a-4e4a-ad99-0760db81e681.sql). If a genuine future need arises to call this base logic without the agent-role check, add a narrowly-scoped SECURITY DEFINER wrapper with its own recorded justification rather than re-granting this function broadly.';

COMMENT ON FUNCTION public.wallet_route_for_category(uuid, text, text)
  IS 'Public entry point for wallet bucket routing. Checks the agent role for a specific set of categories (redirects certain credits/debits to float when the recipient is an agent), then falls through to wallet_route_for_category(text, text) for everything else. Always call THIS version -- see the 2-arg version''s comment for why (Step D, 2026-08-11). Note: wallet_route_for_category is only actually consulted when a general_ledger row has neither an explicit wallet_bucket nor an explicit recipient_type set; either of those wins first (see enforce_no_negative_wallet_ledger''s v_effective_bucket computation).';
