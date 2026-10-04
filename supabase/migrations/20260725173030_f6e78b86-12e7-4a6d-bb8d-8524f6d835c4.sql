CREATE OR REPLACE FUNCTION public.get_agent_listing_campaign(p_agent_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_week_start   timestamptz := date_trunc('week', now());
  v_week_end     timestamptz := date_trunc('week', now()) + interval '7 days';
  v_invited      integer := 0;
  v_activated    integer := 0;
  v_verified     integer := 0;
  v_commission   numeric := 0;
  v_bonus        numeric := 0;
  v_days_left    integer := 0;
  v_house_price  numeric := 3000;
  v_bonus_amount numeric := 40000;
  v_invited_target integer := 20;
  v_activated_target integer := 20;
  v_house_target integer := 60;
  v_total_potential numeric;
  v_total_earned numeric;
BEGIN
  IF NOT (
    p_agent_id = auth.uid()
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  WITH invitees AS (
    SELECT DISTINCT uid FROM (
      SELECT sub_agent_id AS uid
        FROM agent_subagents
       WHERE parent_agent_id = p_agent_id
         AND created_at >= v_week_start AND created_at < v_week_end
         AND status <> 'rejected'
      UNION
      SELECT referred_id
        FROM referrals
       WHERE referrer_id = p_agent_id
         AND created_at >= v_week_start AND created_at < v_week_end
      UNION
      SELECT id
        FROM profiles
       WHERE referrer_id = p_agent_id
         AND created_at >= v_week_start AND created_at < v_week_end
    ) u
  ),
  sub_houses AS (
    SELECT h.agent_id AS uid, count(*) AS verified_houses
      FROM house_listings h
      JOIN invitees i ON i.uid = h.agent_id
     WHERE h.verified = true
       AND h.status <> 'rejected'
       AND COALESCE(h.is_hidden, false) = false
       AND h.created_at >= v_week_start AND h.created_at < v_week_end
     GROUP BY h.agent_id
  )
  SELECT
    (SELECT count(*) FROM invitees),
    (SELECT count(*) FROM sub_houses WHERE verified_houses >= 3),
    COALESCE((SELECT sum(verified_houses) FROM sub_houses), 0)
  INTO v_invited, v_activated, v_verified;

  v_commission := v_verified * v_house_price;

  SELECT COALESCE(amount, 0) INTO v_bonus
    FROM agent_listing_campaign_bonuses
   WHERE agent_id = p_agent_id AND week_start = v_week_start::date;
  v_bonus := COALESCE(v_bonus, 0);

  v_days_left := GREATEST(0, ceil(extract(epoch FROM (v_week_end - now())) / 86400.0)::int);

  v_total_potential := (v_house_target * v_house_price) + v_bonus_amount;
  v_total_earned := v_commission + v_bonus;

  RETURN jsonb_build_object(
    'week_start', v_week_start,
    'week_end', v_week_end,
    'days_remaining', v_days_left,
    'invited_count', v_invited,
    'invited_target', v_invited_target,
    'activated_count', v_activated,
    'activated_target', v_activated_target,
    'verified_houses_count', v_verified,
    'verified_houses_target', v_house_target,
    'house_commission', v_house_price,
    'commission_earned', v_commission,
    'bonus_amount', v_bonus_amount,
    'bonus_earned', v_bonus,
    'bonus_eligible', (v_activated >= v_activated_target),
    'total_potential', v_total_potential,
    'total_earned', v_total_earned,
    'still_available', GREATEST(0, v_total_potential - v_total_earned)
  );
END;
$function$;

-- Update the awarder to match new UGX 40,000 completion bonus
CREATE OR REPLACE FUNCTION public.award_agent_listing_campaign_bonus(p_agent_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_week_start timestamptz := date_trunc('week', now());
  v_week_end   timestamptz := date_trunc('week', now()) + interval '7 days';
  v_progress   jsonb;
  v_bonus_amount numeric := 40000;
  v_source_id  text;
  v_group_id   uuid;
  v_invited    integer;
  v_activated  integer;
  v_verified   integer;
BEGIN
  IF NOT (
    p_agent_id = auth.uid()
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_progress := public.get_agent_listing_campaign(p_agent_id);

  IF NOT (v_progress->>'bonus_eligible')::boolean THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  IF EXISTS (
    SELECT 1 FROM agent_listing_campaign_bonuses
     WHERE agent_id = p_agent_id AND week_start = v_week_start::date
  ) THEN
    RETURN jsonb_build_object('status', 'already_awarded');
  END IF;

  v_invited   := (v_progress->>'invited_count')::int;
  v_activated := (v_progress->>'activated_count')::int;
  v_verified  := (v_progress->>'verified_houses_count')::int;
  v_source_id := 'listing_campaign:' || p_agent_id::text || ':' || v_week_start::date::text;

  v_group_id := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', p_agent_id,
        'amount', v_bonus_amount,
        'direction', 'cash_out',
        'category', 'marketing_expense',
        'source_table', 'commission_engine',
        'source_id', v_source_id,
        'description', 'Marketing expense: Weekly Listing Mission bonus'
      ),
      jsonb_build_object(
        'user_id', p_agent_id,
        'amount', v_bonus_amount,
        'direction', 'cash_in',
        'category', 'agent_bonus',
        'source_table', 'commission_engine',
        'source_id', v_source_id,
        'description', 'Weekly Listing Mission completion bonus'
      )
    )
  );

  INSERT INTO agent_listing_campaign_bonuses(agent_id, week_start, amount, invited_count, activated_count, verified_houses_count, ledger_group_id)
  VALUES (p_agent_id, v_week_start::date, v_bonus_amount, v_invited, v_activated, v_verified, v_group_id);

  RETURN jsonb_build_object('status', 'awarded', 'amount', v_bonus_amount, 'ledger_group_id', v_group_id);
END;
$function$;