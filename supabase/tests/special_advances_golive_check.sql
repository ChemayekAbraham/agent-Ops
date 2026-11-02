-- Special Advances readiness Phase E: production go-live check. READ ONLY: one SELECT that reads catalogs, function
-- fingerprints and Special Advances / ledger figures; it writes nothing and calls no money-moving function.
-- Run it inside a read-only transaction (docs/special-advances/phase-e-golive.md). Every item returns ok true / false.
-- Optional objects (Phases B, C, D, storage policies) are looked up dynamically, so the check runs whatever is applied.
-- Expected fingerprints are those of the committed migrations on sarah-dev (2026-11-02).
WITH fp(item, sig, md5) AS (VALUES
  ('fn: payout (Phase 4)', 'public.special_advance_disburse(uuid,timestamp with time zone,jsonb)', '44065a5c57df6f4f8bf785c80b2b3d15'),
  ('fn: repayment (Phase B)', 'public.special_advance_record_repayment(uuid,jsonb)', '6ccc510d8797574fb5e107065bf966e5'),
  ('fn: position (Phase B)', 'public._special_advance_position(uuid)', 'c17b7e48f943731c5c5f8d29f3c2e9dc'),
  ('fn: repayment verify (Phase B)', 'public._special_advance_verify_repayments()', '50ff7fd66e4ba87d924c7815024fea35'),
  ('fn: status guard (Phase C)', 'public._special_advance_guard_update()', '7c252ea5e107b6b4c6405ad7fbe76f29'),
  ('fn: audit (Phase C)', 'public._special_advance_audit()', '8153c3967e2c2514bb193fa78bef7a6f'),
  ('fn: proof check (Phase C)', 'public._special_advance_check_proof(uuid,text)', '42fe52ca203a12d8f54919ee282d9320'),
  ('fn: eligibility (Phase C)', 'public._special_advance_eligibility(text,uuid,text,text,text,uuid)', 'b5f250ec93466ca074b74feab1d98432'),
  ('fn: statement (Phase C)', 'public.special_advance_statement(uuid)', 'dfb4cb837b35e28cd0bfcd7b6dcddceb'),
  ('fn: reconciliation (Phase C)', 'public.special_advance_reconciliation()', '71689d0f17af58ae872c436f283eab09'),
  ('fn: balance sheet memo (Phase D)', 'public.get_statement_of_financial_position(timestamp with time zone)', '6c6f4d3e43233ae0ca342ff26c35dc21'),
  ('fn: ledger posting (unchanged)', 'public.create_ledger_transaction(jsonb,text,boolean)', '8e570ba579b151ac17788c0ee668a93b')
), mig(v) AS (VALUES ('20261028150000'), ('20261028151000'), ('20261028152000'), ('20261028153000'), ('20261028153100'),
                     ('20261102200000'), ('20261102210000'), ('20261102220000'), ('20261102230000')),
a24 AS (
  SELECT COALESCE(sum(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END), 0) AS ledger
    FROM public.general_ledger gl
    JOIN public.ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.account_code = 'A24'
   WHERE gl.category LIKE 'special\_advance\_%'
), sub AS (
  SELECT COALESCE(sum((public._special_advance_position(a.id) ->> 'outstanding')::numeric), 0) AS outstanding
    FROM public.special_advances a
), checks(item, ok, detail) AS (
  SELECT 'server: Postgres version', true, to_jsonb(current_setting('server_version'))
  UNION ALL
  SELECT 'migrations recorded: ' || v, EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations s WHERE s.version = mig.v),
         (SELECT to_jsonb(s.name) FROM supabase_migrations.schema_migrations s WHERE s.version = mig.v) FROM mig
  UNION ALL
  SELECT fp.item, p.oid IS NOT NULL AND md5(replace(p.prosrc, chr(13), '')) = fp.md5,
         jsonb_build_object('live', CASE WHEN p.oid IS NULL THEN 'missing' ELSE md5(replace(p.prosrc, chr(13), '')) END, 'expected', fp.md5)
    FROM fp LEFT JOIN pg_proc p ON p.oid = to_regprocedure(fp.sig)
  UNION ALL
  SELECT 'tables: corrections, provisions, write-offs, recoveries exist',
         to_regclass('public.special_advance_corrections') IS NOT NULL AND to_regclass('public.special_advance_provision_reviews') IS NOT NULL
         AND to_regclass('public.special_advance_write_offs') IS NOT NULL AND to_regclass('public.special_advance_recoveries') IS NOT NULL,
         jsonb_build_object('corrections', to_regclass('public.special_advance_corrections') IS NOT NULL,
                            'write_offs', to_regclass('public.special_advance_write_offs') IS NOT NULL)
  UNION ALL
  SELECT 'accounts: A24 and A25 exist', (SELECT count(*) FROM public.ledger_account_catalog WHERE code IN ('A24', 'A25')) = 2,
         (SELECT jsonb_agg(code || ' ' || label ORDER BY code) FROM public.ledger_account_catalog WHERE code IN ('A20', 'A24', 'A25'))
  UNION ALL
  SELECT 'mapping: 12 Special Advances rows', (SELECT count(*) FROM public.ledger_account_map WHERE category LIKE 'special\_advance\_%') = 12,
         to_jsonb((SELECT count(*) FROM public.ledger_account_map WHERE category LIKE 'special\_advance\_%'))
  UNION ALL
  SELECT 'allowlist: 12 Special Advances categories',
         (SELECT count(*) FROM unnest(public.ledger_category_allowlist()) c WHERE c LIKE 'special\_advance\_%') = 12,
         to_jsonb((SELECT count(*) FROM unnest(public.ledger_category_allowlist()) c WHERE c LIKE 'special\_advance\_%'))
  UNION ALL
  SELECT 'storage: two proof policies, both requiring aal2',
         (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
             AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'special-advance-proofs'
             AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'aal2') = 2
         AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
             AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'special-advance-proofs' AND cmd IN ('UPDATE', 'DELETE', 'ALL')),
         (SELECT coalesce(jsonb_agg(policyname || ' ' || cmd), '[]'::jsonb) FROM pg_policies WHERE schemaname = 'storage'
             AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'special-advance-proofs')
  UNION ALL
  SELECT 'storage: proof bucket private, 10 MB, images or PDF',
         EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'special-advance-proofs' AND NOT public AND file_size_limit = 10485760),
         (SELECT to_jsonb(b) - 'owner' - 'owner_id' FROM storage.buckets b WHERE id = 'special-advance-proofs')
  UNION ALL
  SELECT 'people: an enabled CFO with a verified authenticator (one CFO does every step, decision 2026-11-03)',
         (SELECT count(DISTINCT ur.user_id) FROM public.user_roles ur
            JOIN auth.mfa_factors f ON f.user_id = ur.user_id AND f.status = 'verified' AND f.factor_type = 'totp'
           WHERE ur.role = 'cfo' AND coalesce(ur.enabled, true)) >= 1,
         jsonb_build_object('enabled_cfos', (SELECT count(DISTINCT user_id) FROM public.user_roles WHERE role = 'cfo' AND coalesce(enabled, true)),
                            'cfos_with_verified_totp', (SELECT count(DISTINCT ur.user_id) FROM public.user_roles ur
                               JOIN auth.mfa_factors f ON f.user_id = ur.user_id AND f.status = 'verified' AND f.factor_type = 'totp'
                              WHERE ur.role = 'cfo' AND coalesce(ur.enabled, true)))
  UNION ALL
  SELECT 'reconciliation: A24 ledger equals paid-out outstanding', (SELECT ledger FROM a24) = (SELECT outstanding FROM sub),
         jsonb_build_object('a24_ledger', (SELECT ledger FROM a24), 'subledger', (SELECT outstanding FROM sub))
  UNION ALL
  SELECT 'ledger: every Special Advances group nets to zero',
         NOT EXISTS (SELECT 1 FROM public.general_ledger gl WHERE gl.category LIKE 'special\_advance%'
                      GROUP BY gl.transaction_group_id HAVING sum(CASE WHEN gl.direction = 'cash_in' THEN gl.amount ELSE -gl.amount END) <> 0),
         to_jsonb((SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger WHERE category LIKE 'special\_advance%'))
  UNION ALL
  SELECT 'queues: nothing awaiting approval',
         NOT coalesce((xpath('/row/n/text()', query_to_xml(
           CASE WHEN to_regclass('public.special_advance_write_offs') IS NOT NULL THEN
             'select (select count(*) from public.special_advance_corrections where status = ''pending'')
                   + (select count(*) from public.special_advance_provision_reviews where status = ''pending'')
                   + (select count(*) from public.special_advance_write_offs where status = ''pending'') as n'
           ELSE 'select 0 as n' END, false, true, '')))[1]::text::int > 0, false),
         to_jsonb((xpath('/row/n/text()', query_to_xml(
           CASE WHEN to_regclass('public.special_advance_corrections') IS NOT NULL
                THEN 'select count(*) as n from public.special_advance_corrections where status = ''pending''' ELSE 'select 0 as n' END,
           false, true, '')))[1]::text)
  UNION ALL
  SELECT 'grants: no Special Advances function executable by anon',
         NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname LIKE '%special_advance%' AND has_function_privilege('anon', p.oid, 'EXECUTE')),
         NULL::jsonb
  UNION ALL
  SELECT 'grants: internal helpers (_special_advance_*) closed to signed-in users',
         NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname LIKE '\_special\_advance\_%' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')),
         (SELECT coalesce(jsonb_agg(p.proname), '[]'::jsonb) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE '\_special\_advance\_%' AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  UNION ALL
  SELECT 'switch: issuance currently OFF (switching on is the last, separate step)',
         NOT public._special_advance_issuance_enabled(),
         (SELECT to_jsonb(s) FROM public.special_advance_settings s)
  UNION ALL
  SELECT 'data: advances by status', true,
         (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb) FROM (SELECT status, count(*) n FROM public.special_advances GROUP BY 1) x)
)
SELECT jsonb_build_object(
  'ready', bool_and(ok) FILTER (WHERE item NOT LIKE 'data:%' AND item NOT LIKE 'server:%'),
  'failed', coalesce(jsonb_agg(item ORDER BY item) FILTER (WHERE NOT ok), '[]'::jsonb),
  'checks', jsonb_agg(jsonb_build_object('item', item, 'ok', ok, 'detail', detail) ORDER BY item)
) AS golive
FROM checks;
