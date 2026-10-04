-- Agents: rebuild from live metrics under the new weights.
WITH agent_ids AS (
  SELECT DISTINCT ur.user_id AS uid FROM public.user_roles ur WHERE ur.role = 'agent'
),
qualifying AS (SELECT q.agent_id AS uid FROM public.agent_ops_qualifying_agent_ids() q),
subs AS (
  SELECT s.parent_agent_id AS uid,
    count(*) FILTER (WHERE s.status IN ('active','verified') OR s.accepted_at IS NOT NULL) AS registered,
    count(*) FILTER (WHERE (s.status IN ('active','verified') OR s.accepted_at IS NOT NULL) AND e.active_count > 0) AS active
  FROM public.agent_subagents s
  JOIN qualifying q ON q.uid = s.sub_agent_id
  LEFT JOIN public.v_agent_daily_eligibility e ON e.agent_id = s.sub_agent_id
  WHERE s.parent_agent_id IS NOT NULL
  GROUP BY s.parent_agent_id
),
coll AS (SELECT ac.agent_id AS uid, coalesce(sum(ac.amount),0) AS amt FROM public.agent_collections ac GROUP BY ac.agent_id),
reqs AS (SELECT rr.agent_id AS uid, count(*) AS cnt FROM public.rent_requests rr
         WHERE rr.agent_id IS NOT NULL AND rr.tenant_id IS NOT NULL AND rr.agent_id <> rr.tenant_id GROUP BY rr.agent_id),
promis AS (SELECT pn.agent_id AS uid, count(*) AS cnt FROM public.promissory_notes pn
           WHERE pn.status IN ('activated','approved') OR pn.approved_at IS NOT NULL GROUP BY pn.agent_id),
calc AS (
  SELECT a.uid,
    LEAST((coalesce(sb.active,0) * 30000) + (coalesce(sb.registered,0) * 9000), 3000000)::numeric AS b_subs,
    LEAST(coalesce(c.amt,0) * 0.06, 2400000)::numeric AS b_coll,
    LEAST(coalesce(r.cnt,0) * 9000, 1500000)::numeric AS b_req,
    LEAST(coalesce(p.cnt,0) * 9000, 600000)::numeric AS b_promis
  FROM agent_ids a
  LEFT JOIN subs sb ON sb.uid = a.uid
  LEFT JOIN coll c ON c.uid = a.uid
  LEFT JOIN reqs r ON r.uid = a.uid
  LEFT JOIN promis p ON p.uid = a.uid
)
UPDATE public.credit_access_limits cal
SET base_limit = 20000,
    bonus_from_subagents = calc.b_subs,
    bonus_from_agent_allocations = calc.b_coll,
    bonus_from_rent_history = calc.b_req,
    bonus_from_partners_onboarded = calc.b_promis,
    bonus_from_houses_listed = 0,
    bonus_from_ratings = 0,
    bonus_from_receipts = 0,
    bonus_from_landlord_rent = 0,
    updated_at = now()
FROM calc
WHERE calc.uid = cal.user_id;

-- Everyone else: scale every ingredient to 30% of its previous value.
UPDATE public.credit_access_limits cal
SET base_limit = 20000,
    bonus_from_ratings = round(coalesce(bonus_from_ratings,0) * 0.30),
    bonus_from_receipts = round(coalesce(bonus_from_receipts,0) * 0.30),
    bonus_from_rent_history = round(coalesce(bonus_from_rent_history,0) * 0.30),
    bonus_from_landlord_rent = round(coalesce(bonus_from_landlord_rent,0) * 0.30),
    bonus_from_houses_listed = round(coalesce(bonus_from_houses_listed,0) * 0.30),
    bonus_from_partners_onboarded = round(coalesce(bonus_from_partners_onboarded,0) * 0.30),
    bonus_from_agent_allocations = round(coalesce(bonus_from_agent_allocations,0) * 0.30),
    bonus_from_subagents = round(coalesce(bonus_from_subagents,0) * 0.30),
    updated_at = now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles ur WHERE ur.user_id = cal.user_id AND ur.role = 'agent'
);