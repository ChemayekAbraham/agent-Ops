\set ON_ERROR_STOP off
\set U1 '2ef293fd-c12e-465d-bfee-129d040412e4'
\set U2 'bd266fc7-1066-468a-8beb-347430d9d9b6'
BEGIN;
SET CONSTRAINTS ALL DEFERRED;

\echo '== 1 system balance correction (expect PASS)'
SAVEPOINT s1;
SELECT create_ledger_transaction(jsonb_build_array(
 jsonb_build_object('user_id',:'U1','amount',1000,'direction','cash_out','category','system_balance_correction','ledger_scope','wallet','wallet_bucket','withdrawable','recipient_type','user','currency','UGX','solvency_bypass_reason','dispute_resolution','reference_id','TEST-EC1','description','regression test'),
 jsonb_build_object('amount',1000,'direction','cash_in','category','system_balance_correction','ledger_scope','platform','currency','UGX','reference_id','TEST-EC1','solvency_bypass_reason','dispute_resolution','description','regression test')
));
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO s1; SET CONSTRAINTS ALL DEFERRED;

\echo '== 2 user-to-user transfer (expect PASS)'
SAVEPOINT s2;
SELECT create_ledger_transaction(jsonb_build_array(
 jsonb_build_object('user_id',:'U1','amount',1000,'direction','cash_out','category','wallet_transfer','ledger_scope','wallet','wallet_bucket','withdrawable','recipient_type','user','currency','UGX','reference_id','TEST-T1'),
 jsonb_build_object('user_id',:'U2','amount',1000,'direction','cash_in','category','wallet_transfer','ledger_scope','wallet','wallet_bucket','withdrawable','recipient_type','user','currency','UGX','reference_id','TEST-T1')
));
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO s2; SET CONSTRAINTS ALL DEFERRED;

\echo '== 3 deposit (expect PASS)'
SAVEPOINT s3;
SELECT create_ledger_transaction(jsonb_build_array(
 jsonb_build_object('user_id',:'U1','amount',1000,'direction','cash_in','category','wallet_deposit','ledger_scope','wallet','wallet_bucket','withdrawable','recipient_type','user','currency','UGX','reference_id','TEST-D1'),
 jsonb_build_object('amount',1000,'direction','cash_out','category','wallet_deposit','ledger_scope','platform','currency','UGX','reference_id','TEST-D1')
));
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO s3; SET CONSTRAINTS ALL DEFERRED;

\echo '== 4 withdrawal (expect PASS)'
SAVEPOINT s4;
SELECT create_ledger_transaction(jsonb_build_array(
 jsonb_build_object('user_id',:'U1','amount',1000,'direction','cash_out','category','wallet_withdrawal','ledger_scope','wallet','wallet_bucket','withdrawable','recipient_type','user','currency','UGX','reference_id','TEST-W1'),
 jsonb_build_object('amount',1000,'direction','cash_in','category','wallet_withdrawal','ledger_scope','platform','currency','UGX','reference_id','TEST-W1')
));
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO s4; SET CONSTRAINTS ALL DEFERRED;

\echo '== 5 invalid mixed classification, non-correction group (expect FAIL)'
SAVEPOINT s5;
SELECT create_ledger_transaction(jsonb_build_array(
 jsonb_build_object('user_id',:'U1','amount',1000,'direction','cash_out','category','wallet_transfer','ledger_scope','wallet','wallet_bucket','withdrawable','recipient_type','user','currency','UGX','reference_id','TEST-M1'),
 jsonb_build_object('user_id',:'U2','amount',1000,'direction','cash_in','category','admin_adjustment','ledger_scope','wallet','wallet_bucket','withdrawable','recipient_type','user','currency','UGX','reference_id','TEST-M1')
));
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO s5; SET CONSTRAINTS ALL DEFERRED;

\echo '== 6 unbalanced correction group (expect FAIL)'
SAVEPOINT s6;
SELECT create_ledger_transaction(jsonb_build_array(
 jsonb_build_object('user_id',:'U1','amount',1000,'direction','cash_out','category','system_balance_correction','ledger_scope','wallet','wallet_bucket','withdrawable','recipient_type','user','currency','UGX','solvency_bypass_reason','dispute_resolution','reference_id','TEST-EC2'),
 jsonb_build_object('amount',500,'direction','cash_in','category','system_balance_correction','ledger_scope','platform','currency','UGX','reference_id','TEST-EC2','solvency_bypass_reason','dispute_resolution')
), NULL, true);
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO s6; SET CONSTRAINTS ALL DEFERRED;

\echo '== 7 unbalanced production group (expect FAIL)'
SAVEPOINT s7;
SELECT create_ledger_transaction(jsonb_build_array(
 jsonb_build_object('user_id',:'U1','amount',1000,'direction','cash_out','category','wallet_transfer','ledger_scope','wallet','wallet_bucket','withdrawable','recipient_type','user','currency','UGX','reference_id','TEST-U1'),
 jsonb_build_object('user_id',:'U2','amount',400,'direction','cash_in','category','wallet_transfer','ledger_scope','wallet','wallet_bucket','withdrawable','recipient_type','user','currency','UGX','reference_id','TEST-U1')
), NULL, true);
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO s7; SET CONSTRAINTS ALL DEFERRED;

\echo '== 8 TRIGGER: unbalanced correction group via direct insert (expect FAIL)'
SAVEPOINT s8;
SELECT set_config('ledger.authorized','true',true);
INSERT INTO general_ledger (user_id, ledger_scope, direction, category, amount, currency, description, source_table, transaction_group_id, transaction_date, reference_id)
VALUES (NULL,'platform','cash_in','system_balance_correction',1000,'UGX','trigger test','ledger_transaction', gen_random_uuid(), now(),'TEST-TG8');
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO s8; SET CONSTRAINTS ALL DEFERRED;

\echo '== 9 TRIGGER: mixed classification, non-correction group (expect FAIL)'
SAVEPOINT s9;
SELECT set_config('ledger.authorized','true',true);
WITH g AS (SELECT '11111111-2222-3333-4444-555555555555'::uuid gid)
INSERT INTO general_ledger (user_id, ledger_scope, direction, category, amount, currency, description, source_table, transaction_group_id, transaction_date, reference_id)
SELECT NULL::uuid,'platform','cash_in','wallet_transfer',1000,'UGX','trigger test','ledger_transaction', gid, now(),'TEST-TG9' FROM g
UNION ALL
SELECT NULL::uuid,'platform','cash_out','wallet_route_repair',1000,'UGX','trigger test','ledger_transaction', gid, now(),'TEST-TG9' FROM g;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO s9;

ROLLBACK;
