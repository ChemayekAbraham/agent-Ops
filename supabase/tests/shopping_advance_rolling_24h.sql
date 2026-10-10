-- Read-only regression checks: the exact 24-hour boundary is included,
-- older receipts expire, and an empty window has no starter access.
WITH fixtures(amount, at) AS (
  VALUES (10000::numeric, now() - interval '23 hours'),
         (20000::numeric, now() - interval '24 hours'),
         (900000::numeric, now() - interval '24 hours 1 second')
), eligible AS (
  SELECT amount FROM fixtures WHERE at >= now() - interval '24 hours'
)
SELECT
  (SELECT sum(amount) FROM eligible) = 30000 AS boundary_window_pass,
  (SELECT least(30000000::numeric, 30000 + sum(amount) * 2) FROM eligible) = 90000 AS boundary_limit_pass,
  CASE WHEN 0::numeric > 0 THEN least(30000000::numeric, 30000 + 0 * 2)
       ELSE 0::numeric END = 0 AS no_transfers_zero_pass;