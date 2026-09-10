INSERT INTO public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
SELECT (now() at time zone 'Africa/Kampala')::date, g.rent_request_id, s.agent_id, s.tenant_id, g.amount
FROM public.rent_plan_schedule_days((now() at time zone 'Africa/Kampala')::date,(now() at time zone 'Africa/Kampala')::date) g
JOIN public.v_rent_plan_schedule s ON s.rent_request_id = g.rent_request_id
WHERE g.rent_request_id = '743d30e7-5cf6-425c-a3bd-aad12ecfbe2d'
ON CONFLICT (day, rent_request_id) DO NOTHING;