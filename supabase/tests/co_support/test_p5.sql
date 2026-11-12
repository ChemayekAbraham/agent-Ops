-- Preview float breakdown (20261115110000). Run on a fresh Phase 1 + 4 DB with that migration applied.
\i harness.sql
-- The real case: half 1,530,000; float 551,486; 357,000 held for the viewer's own share.
CALL tt_run('F01', 'Preview explains the float: balance, held for own share, free, missing', $t$
DECLARE ben uuid := tt_person(15, 2000000, true, true, 'Benjamin Muhanguzi'); me uuid := tt_person(15, 551486);
        r jsonb; mine jsonb; pv jsonb;
BEGIN
  PERFORM tt_as(ben); r := co_support_create(tt_plan(3000000));
  PERFORM tt_as(me); mine := co_support_create(tt_plan(700000));
  pv := co_support_preview(r->>'code');
  ASSERT pv->>'reason' = 'funds_short', 'reason ' || pv;
  ASSERT (pv->>'your_share')::numeric = 1530000, 'half';
  ASSERT (pv->>'float_balance')::numeric = 551486, 'balance ' || pv;
  ASSERT (pv->>'float_held_for_your_shares')::numeric = 357000, 'held ' || pv;
  ASSERT (pv->>'float_held_other')::numeric = 0, 'other';
  ASSERT (pv->>'float_available')::numeric = 194486 AND (pv->>'float_needed')::numeric = 1335514, 'free/needed ' || pv;
  ASSERT jsonb_array_length(pv->'your_open_shares') = 1 AND pv->'your_open_shares'->0->>'title' LIKE '%Rent Plan'
     AND (pv->'your_open_shares'->0->>'held')::numeric = 357000, 'shares ' || pv;
  PERFORM tt_as(NULL); pv := co_support_preview(r->>'code');
  ASSERT NOT (pv ? 'float_balance') AND NOT (pv ? 'your_open_shares'), 'anon sees none of it';
  PERFORM tt_as(ben); pv := co_support_preview(r->>'code');
  ASSERT NOT (pv ? 'float_balance'), 'the sharer sees none of the viewer''s float';
END $t$);
SELECT id || ' ' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || ' ' || title || ' ' || COALESCE(detail,'') FROM tt_result ORDER BY id;
