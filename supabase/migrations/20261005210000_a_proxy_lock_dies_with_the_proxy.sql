-- A proxy commission lock lasts only as long as the proxy does.
--
-- WHAT WAS WRONG
--
-- `commission_resolve_earner` decides who earns on a partner's fund-in. Its
-- first rule is a lock:
--
--     take the earner from this partner's FIRST PAID fund-in, for ever
--
-- The lock honoured nothing else. Once a partner's first fund-in had been
-- commissioned to a managed proxy, that proxy kept earning on every future
-- portfolio the partner funded — even after the proxy was unlinked.
--
-- Unlinking a proxy is how the business ENDS that relationship. It has to end
-- the earning with it, or the unlink does nothing where it matters most.
--
-- FOUND THE HARD WAY. Portfolio WIP2610053262 (700,000, created 2026-10-05)
-- paid a 7,000 fund-in commission to a proxy whose assignment had been inactive
-- since 17 June. The portfolio was then cancelled as test data, and the earner
-- STILL resolved to that proxy, because the paid fund-in row had locked them
-- in. Creating any further portfolio would have paid them again.
--
-- THE RULE NOW
--
-- The lock still applies — a partner's earner should not drift between
-- fund-ins — but a `managed_proxy` lock is honoured only while the assignment
-- behind it is still active, approved and unexpired. When it is not, resolution
-- falls through to the live-relationship search, so the partner earns nobody a
-- commission until they are linked to a proxy again. Exactly the behaviour the
-- unlink is meant to produce.
--
-- A `promissory_note` lock is NOT affected. That path means an agent genuinely
-- introduced the partner, which does not stop being true; it stays permanent.
--
-- BLAST RADIUS, measured 2026-10-05 after applying: 30 partners carry a lock,
-- all 30 still resolve to the same earner, none loses their commission. The
-- rule only bites the moment a proxy is actually unlinked, which is the point.

DO $patch$
DECLARE v_def text; v_new text; v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'commission_resolve_earner';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'commission_resolve_earner not found'; END IF;

  v_def := pg_get_functiondef(v_oid);
  IF v_def LIKE '%proxy lock lasts only as long%' THEN
    RAISE NOTICE 'Already applied - the proxy lock already expires with the proxy.';
    RETURN;
  END IF;

  v_new := replace(v_def,
'       WHERE f.partner_id = p_partner AND f.status = ''paid''
       ORDER BY f.occurred_at, f.created_at',
'       WHERE f.partner_id = p_partner AND f.status = ''paid''
         -- A proxy lock lasts only as long as the proxy does. Unlinking a proxy
         -- is how the business ends that relationship, so it must end the
         -- earning with it: no more commission unless the partner is linked to
         -- a proxy again. A promissory-note referral is a different thing - the
         -- agent genuinely introduced the partner - and stays permanent.
         AND (f.earner_path IS DISTINCT FROM ''managed_proxy''
              OR EXISTS (SELECT 1 FROM public.proxy_agent_assignments a
                          WHERE a.id = f.assignment_id
                            AND a.is_active = true
                            AND coalesce(a.approval_status, ''pending'') = ''approved''
                            AND (a.expires_at IS NULL OR a.expires_at > p_at)))
       ORDER BY f.occurred_at, f.created_at');

  IF v_new = v_def THEN RAISE EXCEPTION 'lock branch anchor not found in commission_resolve_earner'; END IF;
  EXECUTE v_new;
END
$patch$;

-- ---------------------------------------------------------------------------
-- The test-data commission that exposed this was reversed separately, live:
--
--   fund_in_key pf:23e0f9c9-... set to not_commissionable
--   7,000 reversed out of the proxy's withdrawable wallet via
--   create_ledger_transaction, idempotency key
--   fund_in_commission_reversal:pf:23e0f9c9-...
--   the partner's earner then resolved to nobody
--
-- It is recorded here rather than replayed: re-running a ledger reversal from a
-- migration would double-reverse on any environment where it already ran.
-- ---------------------------------------------------------------------------

-- STILL WORTH A LOOK, NOT FIXED HERE
--
-- The attribution that started this recorded earner_path = 'managed_proxy'
-- against an assignment that had been inactive since 17 June, yet the
-- managed_proxy branch of this same function requires a.is_active = true. Either
-- the assignment was briefly reactivated on 2026-10-05, or that branch is not
-- filtering as its source reads. It decides who earns on every partner on the
-- platform, so it deserves its own investigation.
