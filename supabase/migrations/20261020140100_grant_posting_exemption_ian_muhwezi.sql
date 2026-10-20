-- One-day posting grant: IAN MUHWEZI (+256787725122), 2026-10-20.
--
-- At the time of granting he stood at 1 of 13 tenants today and 4 of 19
-- yesterday — a gate figure of 31% against the 50% required, six tenants short.
-- He is not a casualty of a measurement error: he was blocked under the old
-- amount rule too (28.7%), and on 19 October he reached 4 of 19 tenants while
-- collecting 594,799. The grant is a business decision, recorded as one.
INSERT INTO public.agent_posting_gate_exemptions (agent_id, day, reason, granted_by)
VALUES (
  '3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0',
  DATE '2026-10-20',
  'Manual grant for 2026-10-20 requested by Pius Ssenkaali. Agent at 31% coverage (1/13 today, 4/19 yesterday), six tenants short of the 50% gate.',
  '0b109aad-212a-4fd0-ab03-3d7aee9cf397'
)
ON CONFLICT (agent_id, day) DO NOTHING;
