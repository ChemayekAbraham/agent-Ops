
-- Recruiter override: pay the recruiting (parent) agent UGX 3,000 from company funds
-- when a sub-agent's listed house / registered landlord / registered LC1 chairperson is verified.
CREATE OR REPLACE FUNCTION public.credit_recruiter_override(
  p_sub_agent_id uuid,
  p_event_type text,
  p_source_table text,
  p_source_id text,
  p_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_recruiter uuid;
  v_amount NUMERIC := 3000;
  v_idem TEXT;
  v_group_id uuid;
  v_desc TEXT;
BEGIN
  IF p_sub_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_sub_agent');
  END IF;

  -- Find the agent who recruited this sub-agent
  SELECT parent_agent_id INTO v_recruiter
  FROM public.agent_subagents
  WHERE sub_agent_id = p_sub_agent_id
    AND status = 'verified'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_recruiter IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_recruiter');
  END IF;

  -- Never pay the recruiter for their own work
  IF v_recruiter = p_sub_agent_id THEN
    RETURN jsonb_build_object('status','skipped','reason','self');
  END IF;

  v_desc := 'UGX 3,000 recruiter override - ' || p_event_type ||
            COALESCE(' (' || p_label || ')', '');

  v_idem := 'recruiter_override:' || p_event_type || ':' || p_source_id;

  v_group_id := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_recruiter,
        'amount', v_amount,
        'direction', 'cash_in',
        'category', 'agent_commission',
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'source_table', p_source_table,
        'source_id', p_source_id,
        'description', v_desc,
        'currency', 'UGX'
      ),
      jsonb_build_object(
        'user_id', v_recruiter,
        'amount', v_amount,
        'direction', 'cash_out',
        'category', 'marketing_expense',
        'ledger_scope', 'platform',
        'source_table', p_source_table,
        'source_id', p_source_id,
        'description', 'Platform expense: ' || v_desc,
        'currency', 'UGX'
      )
    ),
    v_idem
  );

  RETURN jsonb_build_object('status','credited','recruiter_id',v_recruiter,'amount',v_amount,'group_id',v_group_id);
END;
$function$;

-- Trigger: empty house listed by a sub-agent gets verified
CREATE OR REPLACE FUNCTION public.pay_recruiter_override_house_verified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.verified = true
     AND (OLD.verified IS DISTINCT FROM true)
     AND NEW.agent_id IS NOT NULL
  THEN
    PERFORM public.credit_recruiter_override(
      NEW.agent_id,
      'house_listed_verified',
      'house_listings',
      NEW.id::text,
      NEW.title
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_recruiter_override_house_verified ON public.house_listings;
CREATE TRIGGER trg_recruiter_override_house_verified
AFTER UPDATE OF verified ON public.house_listings
FOR EACH ROW
EXECUTE FUNCTION public.pay_recruiter_override_house_verified();

-- Trigger: landlord registered by a sub-agent gets verified
CREATE OR REPLACE FUNCTION public.pay_recruiter_override_landlord_verified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.verified = true
     AND (OLD.verified IS DISTINCT FROM true)
     AND NEW.registered_by IS NOT NULL
  THEN
    PERFORM public.credit_recruiter_override(
      NEW.registered_by,
      'landlord_verified',
      'landlords',
      NEW.id::text,
      NEW.name
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_recruiter_override_landlord_verified ON public.landlords;
CREATE TRIGGER trg_recruiter_override_landlord_verified
AFTER UPDATE OF verified ON public.landlords
FOR EACH ROW
EXECUTE FUNCTION public.pay_recruiter_override_landlord_verified();

-- Trigger: LC1 chairperson registered by a sub-agent gets verified
CREATE OR REPLACE FUNCTION public.pay_recruiter_override_lc1_verified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.verified = true
     AND (OLD.verified IS DISTINCT FROM true)
     AND NEW.registered_by IS NOT NULL
  THEN
    PERFORM public.credit_recruiter_override(
      NEW.registered_by,
      'lc1_chairperson_verified',
      'lc1_chairpersons',
      NEW.id::text,
      NEW.name
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_recruiter_override_lc1_verified ON public.lc1_chairpersons;
CREATE TRIGGER trg_recruiter_override_lc1_verified
AFTER UPDATE OF verified ON public.lc1_chairpersons
FOR EACH ROW
EXECUTE FUNCTION public.pay_recruiter_override_lc1_verified();
