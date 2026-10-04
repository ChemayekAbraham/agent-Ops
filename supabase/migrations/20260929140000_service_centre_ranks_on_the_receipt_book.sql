-- The Service Centre rankings show what agents actually collected.
--
-- The board at agent/service-center says "how your sub-agents compare on rent
-- repaid" and ranked on Σ `amount_repaid`. That column is the plan BALANCE. It
-- has many writers — deposit settlement, tenant self-payment, ops balance
-- edits, administrative completion — so the board was crediting sub-agents with
-- money they never collected.
--
-- MEASURED 2026-09-29 on the real board this was reported from:
--
--   SHARIFU KALULE      balance 21,719,230   collected 19,840,230
--   Akampurira Onesmus  balance 14,146,179   collected  7,997,279
--   FRED MUWANGUZI      balance 13,116,600   collected  9,099,200
--   ALPHA SSEMA         balance 12,927,982   collected  7,627,382
--   maasa mubakal       balance  6,386,030   collected  4,691,800
--
-- Akampurira's headline figure was nearly double what he took in, and NONE of
-- that gap was reversals — it is money that reached the plan by another route.
-- Reversals are a small part of the story; the basis was the story.
--
-- `get_agent_service_center` now returns `collected_live` on every row of
-- `tenant_list`: the sum of that plan's agent collections with
-- `reversed_at IS NULL`. The receipt book, not the balance. `amount_repaid`
-- stays in the payload untouched — it is still the right figure for "has this
-- plan been cleared", and the board still uses it for exactly that.
--
-- Deleted tenants are dropped at the same time. `rent_requests` has no
-- `deleted_at`, so plan deletion is the `deleted_by_agent` status, which both
-- branches already excluded; profile deletion was not checked at all, which is
-- how a cleared test tenant could keep appearing on a roster.
--
-- The two CTEs are UNION ALL'd by position, so `collected_live` is added in the
-- same place in both. Adding it to only one silently shifts every column after
-- it.

DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_agent_service_center';
  IF v_src IS NULL THEN RAISE EXCEPTION 'get_agent_service_center not found'; END IF;
  IF v_src LIKE '%collected_live%' THEN
    RAISE NOTICE 'Already applied - the roster already carries collected_live.';
    RETURN;
  END IF;

  -- Plans the sub-agent owns.
  v_new := replace(v_src,
$a$           true AS owned_by_subagent,
           r.created_at
    FROM public.rent_requests r
    LEFT JOIN public.profiles p ON p.id = r.tenant_id
    WHERE r.agent_id IN (SELECT sub_agent_id FROM links)
      AND r.status NOT IN ('deleted_by_agent')$a$,
$b$           true AS owned_by_subagent,
           COALESCE((SELECT SUM(c.amount) FROM public.agent_collections c
                      WHERE c.rent_request_id = r.id AND c.reversed_at IS NULL), 0) AS collected_live,
           r.created_at
    FROM public.rent_requests r
    LEFT JOIN public.profiles p ON p.id = r.tenant_id
    WHERE r.agent_id IN (SELECT sub_agent_id FROM links)
      AND r.status NOT IN ('deleted_by_agent')
      AND p.deleted_at IS NULL$b$);
  IF v_new = v_src THEN RAISE EXCEPTION 'rr CTE anchor not found'; END IF;
  v_src := v_new;

  -- Referral-only rows. Same column position, so the UNION ALL still lines up.
  v_new := replace(v_src,
$a$           false AS owned_by_subagent,
           lr.created_at
    FROM public.profiles p$a$,
$b$           false AS owned_by_subagent,
           COALESCE((SELECT SUM(c.amount) FROM public.agent_collections c
                      WHERE c.rent_request_id = lr.id AND c.reversed_at IS NULL), 0) AS collected_live,
           lr.created_at
    FROM public.profiles p$b$);
  IF v_new = v_src THEN RAISE EXCEPTION 'referred CTE anchor not found'; END IF;
  v_src := v_new;

  v_new := replace(v_src,
$a$    WHERE p.referrer_id IN (SELECT sub_agent_id FROM links)$a$,
$b$    WHERE p.referrer_id IN (SELECT sub_agent_id FROM links)
      AND p.deleted_at IS NULL$b$);
  IF v_new = v_src THEN RAISE EXCEPTION 'referred WHERE anchor not found'; END IF;
  v_src := v_new;

  v_new := replace(v_src,
    '''amount_repaid'', a.amount_repaid,',
    '''amount_repaid'', a.amount_repaid,
               ''collected_live'', a.collected_live,');
  IF v_new = v_src THEN RAISE EXCEPTION 'tenant_list anchor not found'; END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_agent_service_center()
     RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public''
     AS %L', v_new);
END
$patch$;
