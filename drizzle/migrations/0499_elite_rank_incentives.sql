-- Elite rank incentives (follows drizzle 0498_agent_elite_ranks): the money side of the top-4 agent ranks.
--   1. UGX 5,000 to the parent agent when a sub-agent's tenant gets their first funded Rent Plan.
--   2. UGX 200 to the original agent when the person they invited invites someone who then qualifies.
--   3. A ranked agent keeps the full 10% commission instead of 8% (the 2% recruiter override is skipped).
-- Source: supabase/migrations/20261007180000_elite_rank_incentives.sql (applied verbatim).

CREATE OR REPLACE FUNCTION public.elite_incentive_max_rank()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 4 $$;
REVOKE ALL ON FUNCTION public.elite_incentive_max_rank() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_subagent_commission_whitelisted(p_sub_agent_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agent_subagent_commission_whitelist w
    WHERE w.sub_agent_id = p_sub_agent_id AND w.whitelisted = true
  ) OR EXISTS (
    SELECT 1 FROM public.agent_elite_ranks e
    WHERE e.agent_id = p_sub_agent_id
  );
$$;

CREATE OR REPLACE FUNCTION public.credit_elite_subagent_tenant_bounty()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_amount CONSTANT numeric := 5000;
  v_parent uuid;
  v_desc text;
  v_group uuid;
BEGIN
  IF NEW.tenant_id IS NULL OR NEW.agent_id IS NULL THEN RETURN NEW; END IF;

  IF EXISTS (
    SELECT 1 FROM public.rent_requests o
    WHERE o.tenant_id = NEW.tenant_id AND o.id <> NEW.id
      AND o.status IN ('funded','repaying','completed')
  ) THEN RETURN NEW; END IF;

  SELECT sa.parent_agent_id INTO v_parent
    FROM public.agent_subagents sa
   WHERE sa.sub_agent_id = NEW.agent_id AND sa.status = 'verified' AND sa.parent_agent_id <> sa.sub_agent_id
   ORDER BY sa.created_at ASC LIMIT 1;
  IF v_parent IS NULL OR v_parent = NEW.tenant_id THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.agent_elite_ranks e
    WHERE e.agent_id = v_parent AND e.rank_position <= public.elite_incentive_max_rank()
  ) THEN RETURN NEW; END IF;

  v_desc := 'Sub-agent tenant reward: UGX ' || to_char(v_amount, 'FM999,999') || ' for your sub-agent''s tenant''s first funded Rent Plan';

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object('user_id', v_parent, 'amount', v_amount, 'direction', 'cash_in', 'category', 'agent_commission',
        'ledger_scope', 'wallet', 'recipient_type', 'user', 'source_table', 'rent_requests', 'source_id', NEW.id::text,
        'description', v_desc),
      jsonb_build_object('user_id', v_parent, 'amount', v_amount, 'direction', 'cash_out', 'category', 'marketing_expense',
        'ledger_scope', 'platform', 'source_table', 'rent_requests', 'source_id', NEW.id::text,
        'description', 'Marketing expense: ' || v_desc)
    ),
    'elite_subagent_tenant_bounty:' || NEW.tenant_id::text
  );

  BEGIN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (v_parent, 'Sub-agent tenant reward: UGX 5,000',
      'A tenant registered by your sub-agent just had their first Rent Plan funded. UGX 5,000 is now in your wallet.',
      'earning', jsonb_build_object('amount', v_amount, 'rent_request_id', NEW.id, 'ledger_group_id', v_group));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'credit_elite_subagent_tenant_bounty failed for rent_request %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.credit_elite_subagent_tenant_bounty() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_elite_subagent_tenant_bounty ON public.rent_requests;
CREATE TRIGGER trg_elite_subagent_tenant_bounty
  AFTER UPDATE OF status ON public.rent_requests
  FOR EACH ROW
  WHEN (NEW.status IN ('funded','repaying') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.credit_elite_subagent_tenant_bounty();

CREATE OR REPLACE FUNCTION public.credit_elite_second_degree_bonus()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_amount CONSTANT numeric := 200;
  v_orig uuid;
  v_desc text;
  v_group uuid;
BEGIN
  IF NEW.referrer_id IS NULL OR NEW.referred_id IS NULL THEN RETURN NEW; END IF;

  FOR v_orig IN
    SELECT DISTINCT a.agent_id FROM (
      SELECT r.referrer_id AS agent_id FROM public.referrals r WHERE r.referred_id = NEW.referrer_id
      UNION
      SELECT sa.parent_agent_id FROM public.agent_subagents sa WHERE sa.sub_agent_id = NEW.referrer_id AND sa.status = 'verified'
    ) a
    WHERE a.agent_id IS NOT NULL AND a.agent_id NOT IN (NEW.referrer_id, NEW.referred_id)
  LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.agent_elite_ranks e
      WHERE e.agent_id = v_orig AND e.rank_position <= public.elite_incentive_max_rank()
    );
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_orig AND COALESCE(p.is_frozen, false));

    BEGIN
      v_desc := 'Invite reward: UGX ' || to_char(v_amount, 'FM999') || ' because someone your invitee invited has been verified';

      v_group := public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_orig, 'amount', v_amount, 'direction', 'cash_in', 'category', 'referral_bonus',
            'ledger_scope', 'wallet', 'recipient_type', 'user', 'source_table', 'referrals', 'source_id', NEW.id::text,
            'description', v_desc),
          jsonb_build_object('user_id', v_orig, 'amount', v_amount, 'direction', 'cash_out', 'category', 'marketing_expense',
            'ledger_scope', 'platform', 'source_table', 'referrals', 'source_id', NEW.id::text,
            'description', 'Marketing expense: ' || v_desc)
        ),
        'elite_second_degree_bonus:' || NEW.id::text || ':' || v_orig::text
      );

      BEGIN
        INSERT INTO public.notifications (user_id, title, message, type, metadata)
        VALUES (v_orig, 'Invite reward: UGX 200',
          'Someone your invitee invited has been verified. UGX 200 is now in your wallet.',
          'earning', jsonb_build_object('amount', v_amount, 'referral_id', NEW.id, 'ledger_group_id', v_group));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'credit_elite_second_degree_bonus failed for referral % / agent %: %', NEW.id, v_orig, SQLERRM;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.credit_elite_second_degree_bonus() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_elite_second_degree_bonus ON public.referrals;
CREATE TRIGGER trg_elite_second_degree_bonus
  AFTER UPDATE OF unlocked ON public.referrals
  FOR EACH ROW
  WHEN (NEW.unlocked IS TRUE AND COALESCE(OLD.unlocked, false) = false)
  EXECUTE FUNCTION public.credit_elite_second_degree_bonus();