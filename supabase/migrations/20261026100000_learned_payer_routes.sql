-- Learn from the first manual route: the next deposit from the same payer goes to the same wallet on its own.
--
-- WHY: tenants of agents such as Ian and Martin pay through Airtel / MoMo agents whose numbers are not registered here, so the phone and name auto-match
-- cannot find a wallet and the money waits for staff to route it by hand. Once staff route a payer to a wallet ONCE, the system now remembers it.
--
-- HOW: (1) email_routing_history gets an AFTER INSERT trigger that remembers the payer (phone key, name key) -> wallet -> route type
--      (operational_float or personal_deposit; withdrawable_debit routes are not learned).
--      (2) auto_create_deposits_from_gmail_impl (runs for every new payment SMS and every 2 minutes) asks learned_payer_target() when the SMS phone matches no
--      profile. If it answers, the SAME deposit pipeline the phone match uses creates the deposit request for that wallet (same approval, ledger, duplicate-TID
--      guard and notifications). Nothing new moves money.
--
-- GUARDRAILS (each one stops an auto-route and leaves the payment for staff):
--   * Amount over the limit (settings row, UGX 1,000,000) -> not auto-routed; shows up in get_learned_payer_suggestions().
--   * SHARED NUMBERS: a payer key that has been routed to TWO OR MORE different wallets is a shop / money-agent number and is never auto-routed again.
--   * Only payments received AFTER the payer was learned. Older unmatched payments are not swept up.
--   * Never a payment staff already routed (email_routing_history row), never a TID already used (existing duplicate-TID guard).
--   * Never to an active merchant desk (those are float returns, handled by their own flow) and never an agent's personal_deposit (needs the agent's own confirmation).
--   * One failed auto-route never stops the sweep: it is skipped and logged as a warning.
--   * Every auto-route is written to learned_payer_auto_routes for review. To undo one, use the existing "Reverse auto-credit" in Financial Ops.
--   * learned_payer_route_settings.enabled = false switches the whole feature off. Plain phone/name/TID matching is unchanged.
-- ALSO: auto_match_email_deposits now treats a depositor's name as matching when all the words are present in any order
--       ("JUDITH KYOMUGISHA" finds "kyomugisha judith").
-- Forward only: nothing is learned from past routes (an optional backfill is at the bottom, commented out).
-- Roll back with 20261026100000_learned_payer_routes.rollback.sql.

CREATE TABLE IF NOT EXISTS public.learned_payer_route_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT true,
  max_amount numeric NOT NULL DEFAULT 1000000 CHECK (max_amount > 0),
  name_keys_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.learned_payer_route_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.learned_payer_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_type text NOT NULL CHECK (key_type IN ('phone', 'name')),
  payer_key text NOT NULL,
  target_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  route text NOT NULL CHECK (route IN ('operational_float', 'personal_deposit')),
  hits integer NOT NULL DEFAULT 1,
  learned_at timestamptz NOT NULL DEFAULT now(),
  last_routed_at timestamptz NOT NULL DEFAULT now(),
  first_history_id uuid,
  disabled boolean NOT NULL DEFAULT false,
  UNIQUE (key_type, payer_key, target_user_id)
);
CREATE INDEX IF NOT EXISTS learned_payer_routes_key_idx ON public.learned_payer_routes (key_type, payer_key);

CREATE TABLE IF NOT EXISTS public.learned_payer_auto_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_transaction_id uuid NOT NULL UNIQUE,
  deposit_request_id uuid,
  transaction_id text,
  key_type text NOT NULL,
  payer_key text NOT NULL,
  target_user_id uuid NOT NULL,
  route text NOT NULL,
  amount numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.learned_payer_route_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learned_payer_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learned_payer_auto_routes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.learned_payer_route_settings, public.learned_payer_routes, public.learned_payer_auto_routes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.learned_payer_route_settings, public.learned_payer_routes, public.learned_payer_auto_routes TO authenticated;
GRANT ALL ON public.learned_payer_route_settings, public.learned_payer_routes, public.learned_payer_auto_routes TO service_role;
DROP POLICY IF EXISTS learned_payer_settings_read ON public.learned_payer_route_settings;
CREATE POLICY learned_payer_settings_read ON public.learned_payer_route_settings FOR SELECT TO authenticated USING (public.can_view_finance_reports(auth.uid()));
DROP POLICY IF EXISTS learned_payer_routes_read ON public.learned_payer_routes;
CREATE POLICY learned_payer_routes_read ON public.learned_payer_routes FOR SELECT TO authenticated USING (public.can_view_finance_reports(auth.uid()));
DROP POLICY IF EXISTS learned_payer_auto_routes_read ON public.learned_payer_auto_routes;
CREATE POLICY learned_payer_auto_routes_read ON public.learned_payer_auto_routes FOR SELECT TO authenticated USING (public.can_view_finance_reports(auth.uid()));

-- Last 9 digits of a phone-looking payer value (MTN 2567xxxxxxxx, Airtel 7xxxxxxxx, 07xxxxxxxx); NULL for names, bank text and anything shorter.
CREATE OR REPLACE FUNCTION public.payer_phone_key(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(d) >= 9 AND length(d) <= 12 THEN right(d, 9) END
    FROM (SELECT regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g') AS d) x;
$$;

-- A payer name in one fixed form: lower case letters, words of 2+ letters, sorted, so word order does not matter. NULL unless it has at least two words.
CREATE OR REPLACE FUNCTION public.payer_name_key(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN count(*) >= 2 THEN string_agg(w, ' ' ORDER BY w) END
    FROM (SELECT w FROM unnest(string_to_array(trim(regexp_replace(lower(coalesce(p_value, '')), '[^a-z ]', ' ', 'g')), ' ')) AS w
           WHERE length(w) >= 2 AND w NOT IN ('you', 'have', 'received', 'from', 'the', 'and')) x;
$$;

-- LEARN: remember where staff routed a payer.
CREATE OR REPLACE FUNCTION public.learn_payer_route_from_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE g record; pk text; nk text;
BEGIN
  BEGIN
    IF NEW.route NOT IN ('operational_float', 'personal_deposit') OR NEW.target_user_id IS NULL OR NEW.gmail_transaction_id IS NULL THEN RETURN NEW; END IF;
    SELECT counterparty, counterparty_name INTO g FROM public.gmail_transactions WHERE id = NEW.gmail_transaction_id;
    IF NOT FOUND THEN RETURN NEW; END IF;
    pk := public.payer_phone_key(g.counterparty);
    nk := public.payer_name_key(g.counterparty_name);
    IF pk IS NOT NULL THEN
      INSERT INTO public.learned_payer_routes (key_type, payer_key, target_user_id, route, first_history_id)
      VALUES ('phone', pk, NEW.target_user_id, NEW.route, NEW.id)
      ON CONFLICT (key_type, payer_key, target_user_id) DO UPDATE
        SET hits = learned_payer_routes.hits + 1, last_routed_at = now(), route = EXCLUDED.route;
    END IF;
    IF nk IS NOT NULL THEN
      INSERT INTO public.learned_payer_routes (key_type, payer_key, target_user_id, route, first_history_id)
      VALUES ('name', nk, NEW.target_user_id, NEW.route, NEW.id)
      ON CONFLICT (key_type, payer_key, target_user_id) DO UPDATE
        SET hits = learned_payer_routes.hits + 1, last_routed_at = now(), route = EXCLUDED.route;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'learn_payer_route_from_history: % (the route itself is unaffected)', SQLERRM;
  END;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.learn_payer_route_from_history() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_learn_payer_route ON public.email_routing_history;
CREATE TRIGGER trg_learn_payer_route AFTER INSERT ON public.email_routing_history
  FOR EACH ROW EXECUTE FUNCTION public.learn_payer_route_from_history();

-- ANSWER: where would this payment go on its own? One row, or nothing.
-- p_ignore_limit = true is only for the suggestions list (payments over the limit still have a suggested wallet).
CREATE OR REPLACE FUNCTION public.learned_payer_target(p_gmail_id uuid, p_ignore_limit boolean DEFAULT false)
RETURNS TABLE(target_user_id uuid, route text, key_type text, payer_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE s record; g record; pk text; nk text; n integer; r record;
BEGIN
  SELECT * INTO s FROM public.learned_payer_route_settings WHERE id;
  IF NOT FOUND OR NOT s.enabled THEN RETURN; END IF;
  SELECT x.id, x.amount, x.counterparty, x.counterparty_name, x.created_at INTO g FROM public.gmail_transactions x WHERE x.id = p_gmail_id;
  IF NOT FOUND OR g.amount IS NULL THEN RETURN; END IF;
  IF NOT p_ignore_limit AND g.amount > s.max_amount THEN RETURN; END IF;
  -- Staff already routed this payment: never again.
  IF EXISTS (SELECT 1 FROM public.email_routing_history h WHERE h.gmail_transaction_id = g.id) THEN RETURN; END IF;

  pk := public.payer_phone_key(g.counterparty);
  IF pk IS NOT NULL THEN
    SELECT count(DISTINCT l.target_user_id) INTO n FROM public.learned_payer_routes l WHERE l.key_type = 'phone' AND l.payer_key = pk AND NOT l.disabled;
    IF n > 1 THEN RETURN; END IF;                       -- a shop / money-agent number: never auto-route
    IF n = 1 THEN
      SELECT l.* INTO r FROM public.learned_payer_routes l WHERE l.key_type = 'phone' AND l.payer_key = pk AND NOT l.disabled;
      IF g.created_at > r.learned_at THEN
        RETURN QUERY SELECT r.target_user_id, r.route, 'phone'::text, pk;
      END IF;
      RETURN;
    END IF;
  END IF;

  IF s.name_keys_enabled THEN
    nk := public.payer_name_key(g.counterparty_name);
    IF nk IS NOT NULL THEN
      SELECT count(DISTINCT l.target_user_id) INTO n FROM public.learned_payer_routes l WHERE l.key_type = 'name' AND l.payer_key = nk AND NOT l.disabled;
      IF n = 1 THEN
        SELECT l.* INTO r FROM public.learned_payer_routes l WHERE l.key_type = 'name' AND l.payer_key = nk AND NOT l.disabled;
        IF g.created_at > r.learned_at THEN
          RETURN QUERY SELECT r.target_user_id, r.route, 'name'::text, nk;
        END IF;
      END IF;
    END IF;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.learned_payer_target(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- REVIEW LIST for Financial Ops: unmatched payments of the last 14 days whose payer has a learned wallet but were not auto-routed (usually over the limit).
CREATE OR REPLACE FUNCTION public.get_learned_payer_suggestions()
RETURNS TABLE(gmail_transaction_id uuid, transaction_id text, amount numeric, received_at timestamptz, payer_name text, payer_phone text,
              suggested_user_id uuid, suggested_name text, route text, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.can_view_finance_reports(auth.uid()) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT g.id, g.transaction_id, g.amount, g.created_at, g.counterparty_name, g.counterparty, t.target_user_id, p.full_name, t.route,
         CASE WHEN g.amount > (SELECT max_amount FROM public.learned_payer_route_settings WHERE id) THEN 'Over the auto-route limit: route it by hand'
              ELSE 'Will be routed on the next sweep' END
    FROM public.gmail_transactions g
   CROSS JOIN LATERAL public.learned_payer_target(g.id, true) t
    LEFT JOIN public.profiles p ON p.id = t.target_user_id
   WHERE g.created_at > now() - interval '14 days' AND g.direction IN ('in', 'credit') AND g.linked_deposit_request_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.deposit_requests d WHERE lower(trim(d.transaction_id)) = lower(trim(g.transaction_id)))
   ORDER BY g.created_at DESC;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_learned_payer_suggestions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_learned_payer_suggestions() TO authenticated;

-- THE SWEEP: the existing phone-match flow, plus the learned fallback. Everything not marked "learned" below is unchanged.
CREATE OR REPLACE FUNCTION public.auto_create_deposits_from_gmail_impl(p_window_hours integer DEFAULT 24)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_tx record;
  v_phone_match text;
  v_phone_norm  text;
  v_bare_count  integer;
  v_user_id     uuid;
  v_provider    text;
  v_haystack    text;
  v_haystack_l  text;
  v_is_agent    boolean;
  v_inferred_purpose deposit_purpose;
  v_inference_reason text;
  v_inference_keyword text;
  v_created     integer := 0;
  v_new_id      uuid;
  v_l_target    uuid;        -- learned
  v_l_route     text;        -- learned
  v_l_ktype     text;        -- learned
  v_l_key       text;        -- learned
  v_learned     boolean;     -- learned
begin
  for v_tx in
    select g.id, g.amount, g.transaction_id, g.counterparty, g.internal_date,
           g.subject, g.snippet, g.raw_body, g.from_email
      from gmail_transactions g
     where g.linked_deposit_request_id is null
       and g.parsed = true
       and g.direction in ('in','credit')
       and g.amount is not null
       and g.amount > 0
       and g.transaction_id is not null
       and length(trim(g.transaction_id)) > 0
       and (g.internal_date is null
            or g.internal_date >= (now() - (p_window_hours || ' hours')::interval))
     order by g.internal_date desc nulls last
     limit 200
  loop
    if exists (
      select 1 from deposit_requests d
       where d.transaction_id is not null
         and lower(trim(d.transaction_id)) = lower(trim(v_tx.transaction_id))
    ) then
      continue;
    end if;

    v_user_id := null;        -- learned
    v_learned := false;       -- learned
    v_l_target := null; v_l_route := null; v_l_ktype := null; v_l_key := null;   -- learned

    v_haystack := concat_ws(' ',
      coalesce(v_tx.snippet, ''),
      coalesce(v_tx.subject, ''),
      coalesce(v_tx.counterparty, ''),
      coalesce(v_tx.raw_body, '')
    );

    v_phone_match := substring(v_haystack from '256[0-9]{9}');
    if v_phone_match is null then
      v_phone_match := substring(v_haystack from '0[7][0-9]{8}');
    end if;
    -- Bare 9-digit fallback (Airtel writes "from 704825473"). Only accepted
    -- when EXACTLY ONE distinct bare number appears in the whole email, so a
    -- digit run inside a reference string can never mis-credit someone.
    if v_phone_match is null then
      select count(distinct m[1]) into v_bare_count
        from regexp_matches(v_haystack, '(?<![0-9])(7[0-9]{8})(?![0-9])', 'g') as m;
      if coalesce(v_bare_count, 0) = 1 then
        v_phone_match := '0' || substring(v_haystack from '(?<![0-9])(7[0-9]{8})(?![0-9])');
      end if;
    end if;

    if v_phone_match is not null then          -- learned: was "if null then continue"
      if v_phone_match like '256%' then
        v_phone_norm := '0' || substring(v_phone_match from 4);
      else
        v_phone_norm := v_phone_match;
      end if;

      select p.id into v_user_id
        from profiles p
       where regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') in (
               regexp_replace(v_phone_match, '[^0-9]', '', 'g'),
               regexp_replace(v_phone_norm,  '[^0-9]', '', 'g'),
               '256' || substring(v_phone_norm from 2)
             )
       limit 1;
    end if;

    -- learned: no profile owns the payer's number (or the SMS shows none): ask what staff taught the system.
    if v_user_id is null then
      select t.target_user_id, t.route, t.key_type, t.payer_key into v_l_target, v_l_route, v_l_ktype, v_l_key from public.learned_payer_target(v_tx.id) t;
      if v_l_target is null then continue; end if;
      v_user_id := v_l_target;
      v_learned := true;
    end if;

    -- MERCHANT DESK RETURN (2026-09-26): money from an active merchant desk's
    -- phone is company float coming back, not a deposit. Record the return
    -- against the desk automatically; anything it cannot post is alerted.
    if public.is_merchant_agent(v_user_id) then
      if v_learned then continue; end if;      -- learned: never auto-route to a merchant desk
      begin
        perform public.auto_record_merchant_float_return(v_tx.id, v_user_id, 'phone');
      exception when others then
        -- One failed posting must not abort the rest of the batch. The
        -- subtransaction is rolled back; Financial Ops gets the receipt.
        insert into deposit_match_alerts (
          alert_type, subject_id, subject_label, user_id, amount,
          transaction_reference, severity, details, resolved_at, updated_at
        ) values (
          'merchant_float_return', v_tx.id,
          'Merchant desk sent money to the company - check the float return',
          v_user_id, v_tx.amount, v_tx.transaction_id, 'high',
          jsonb_build_object('reason', 'auto_record_failed', 'error', sqlerrm,
                             'source', 'auto_create_deposits_from_gmail',
                             'counterparty', v_tx.counterparty, 'observed_at', now()),
          null, now()
        )
        on conflict (alert_type, subject_id) do update
          set updated_at = excluded.updated_at, details = excluded.details;
      end;
      continue;
    end if;

    if exists (
      select 1 from deposit_requests d
       where d.user_id = v_user_id
         and d.status = 'pending'
         and abs(d.amount - v_tx.amount) < 0.5
         and d.created_at >= (now() - (p_window_hours || ' hours')::interval)
    ) then continue; end if;

    v_provider := case
      when v_haystack ilike '%momo%' or v_haystack ilike '%mtn%' then 'mtn'
      when v_haystack ilike '%airtel%' then 'airtel'
      else 'mtn'
    end;

    v_is_agent := exists (
      select 1 from user_roles ur
       where ur.user_id = v_user_id
         and ur.role = 'agent'
         and coalesce(ur.enabled, true) = true
    );

    v_haystack_l := lower(v_haystack);
    v_inferred_purpose := null;
    v_inference_reason := null;
    v_inference_keyword := null;

    if v_learned then
      -- learned: an agent's personal deposit needs the agent's own confirmation, so it stays for staff.
      if v_l_route = 'personal_deposit' and v_is_agent then continue; end if;
      v_inferred_purpose := v_l_route::deposit_purpose;
      v_inference_reason := 'learned_payer_route';
    elsif v_is_agent then
      -- FLOAT-BY-DEFAULT FOR AGENTS (2026-07-28)
      if v_haystack_l ~ '\m(operational\s+float|op\.?\s*float|agent\s+float|company\s+float|welile\s+float|float\s+top\s*-?\s*up|top\s*-?\s*up\s+float|fund\s+float|float\s+funding|float\s+deposit|reload\s+float|recharge\s+float)\M' then
        v_inferred_purpose := 'operational_float';
        v_inference_reason := 'sms_keyword_match';
        v_inference_keyword := substring(v_haystack_l from '\m(operational\s+float|op\.?\s*float|agent\s+float|company\s+float|welile\s+float|float\s+top\s*-?\s*up|top\s*-?\s*up\s+float|fund\s+float|float\s+funding|float\s+deposit|reload\s+float|recharge\s+float)\M');
      elsif v_haystack_l ~ '\mfloat\M' then
        v_inferred_purpose := 'operational_float';
        v_inference_reason := 'sms_keyword_match';
        v_inference_keyword := 'float';
      else
        v_inferred_purpose := 'operational_float';
        v_inference_reason := 'agent_float_by_default';
        v_inference_keyword := null;
      end if;
    end if;

    begin
      insert into deposit_requests (
        user_id, amount, transaction_id, status, provider,
        deposit_purpose, purpose_audit,
        notes, created_at
      ) values (
        v_user_id, v_tx.amount, v_tx.transaction_id, 'pending', v_provider,
        coalesce(v_inferred_purpose, 'other'::deposit_purpose),
        jsonb_build_object(
          'inferred_at', now(),
          'inferred_by', 'auto_create_deposits_from_gmail',
          'gmail_transaction_id', v_tx.id,
          'is_agent', v_is_agent,
          'inferred_purpose', v_inferred_purpose,
          'inference_reason', coalesce(v_inference_reason, 'no_match'),
          'inference_keyword', v_inference_keyword,
          'requires_confirmation', v_inferred_purpose is null,
          'routing_hint', case when v_inferred_purpose = 'operational_float' then 'float' else null end,
          'learned_payer_key_type', v_l_ktype,      -- learned
          'learned_payer_key', v_l_key           -- learned
        ),
        case
          when v_learned
            then '[auto] Auto-routed from Gmail receipt ' || v_tx.id::text
                 || ' — this payer was routed to this wallet by staff before (' || v_l_ktype || ' match).'
          when v_inference_reason = 'agent_float_by_default'
            then '[auto] Auto-created from Gmail receipt ' || v_tx.id::text
                 || ' — agent user, float-by-default routing applied.'
          when v_inferred_purpose = 'operational_float'
            then '[auto] Auto-created from Gmail receipt ' || v_tx.id::text
                 || ' — pre-tagged as operational_float (matched keyword: '
                 || coalesce(v_inference_keyword, 'float') || '). Awaiting confirmation.'
          else '[auto] Auto-created from Gmail receipt ' || v_tx.id::text
               || ' — awaiting purpose confirmation'
        end,
        now()
      ) returning id into v_new_id;
    exception when others then
      -- learned: one auto-route that cannot be created must not stop the sweep. Every other path fails as it always did.
      if v_learned then
        raise warning 'learned payer auto-route skipped for %: %', v_tx.id, sqlerrm;
        continue;
      end if;
      raise;
    end;

    update gmail_transactions
       set linked_deposit_request_id = v_new_id,
           auto_matched_at = now(),
           auto_match_method = 'tid'
     where id = v_tx.id
       and linked_deposit_request_id is null;

    if v_learned then
      insert into learned_payer_auto_routes (gmail_transaction_id, deposit_request_id, transaction_id, key_type, payer_key, target_user_id, route, amount)
      values (v_tx.id, v_new_id, v_tx.transaction_id, v_l_ktype, v_l_key, v_user_id, v_l_route, v_tx.amount)
      on conflict (gmail_transaction_id) do nothing;
    end if;

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$function$;

-- NAME MATCH WITHOUT WORD ORDER: add "every word of the depositor's name is in the SMS, in any order" to the existing name signal.
DO $patch$
DECLARE v_def text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p WHERE p.proname = 'auto_match_email_deposits' AND p.pronamespace = 'public'::regnamespace;
  v_old := $o$OR (c.from_name IS NOT NULL AND lower(c.from_name) LIKE '%' || lower(trim(v_pending.full_name)) || '%'))$o$;
  v_new := $n$OR (c.from_name IS NOT NULL AND lower(c.from_name) LIKE '%' || lower(trim(v_pending.full_name)) || '%')
                OR (SELECT count(*) >= 2 AND bool_and(position(w IN lower(coalesce(c.counterparty, '') || ' ' || coalesce(c.from_name, ''))) > 0)
                      FROM unnest(string_to_array(lower(trim(v_pending.full_name)), ' ')) AS w WHERE length(w) >= 2))$n$;
  IF position('any order' IN v_def) > 0 THEN RETURN; END IF;           -- already patched
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'auto_match_email_deposits changed: the name match could not be patched (nothing was changed)'; END IF;
  v_def := replace(v_def, v_old, v_new);
  v_def := replace(v_def, 'CASE WHEN v_pending.full_name IS NOT NULL AND length(trim(v_pending.full_name)) >= 3', 'CASE /* any order */ WHEN v_pending.full_name IS NOT NULL AND length(trim(v_pending.full_name)) >= 3');
  EXECUTE v_def;
END
$patch$;

-- OPTIONAL BACKFILL (not run): learn from the last 60 days of routes now, so repeat payers are covered immediately. Shared numbers are excluded
-- automatically (a key routed to 2+ wallets is never auto-routed), but check get_learned_payer_suggestions() afterwards.
-- INSERT INTO public.learned_payer_routes (key_type, payer_key, target_user_id, route, hits, learned_at, last_routed_at, first_history_id)
-- SELECT 'phone', public.payer_phone_key(g.counterparty), h.target_user_id, (array_agg(h.route ORDER BY h.created_at DESC))[1], count(*), min(h.created_at), max(h.created_at), (array_agg(h.id ORDER BY h.created_at))[1]
--   FROM public.email_routing_history h JOIN public.gmail_transactions g ON g.id = h.gmail_transaction_id
--  WHERE h.created_at > now() - interval '60 days' AND h.route IN ('operational_float', 'personal_deposit') AND h.target_user_id IS NOT NULL
--    AND public.payer_phone_key(g.counterparty) IS NOT NULL
--  GROUP BY public.payer_phone_key(g.counterparty), h.target_user_id
-- ON CONFLICT (key_type, payer_key, target_user_id) DO NOTHING;
