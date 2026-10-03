CREATE SCHEMA auth; CREATE TABLE auth.cur(uid uuid); INSERT INTO auth.cur VALUES (NULL);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT uid FROM auth.cur';
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
CREATE TYPE solvency_bypass_reason AS ENUM ('duplicate_reversal','other_with_note');
CREATE TABLE agent_collections(id uuid primary key, amount numeric, rent_request_id uuid, reversed_at timestamptz, notes text);
CREATE TABLE fin_s14_batch_cases(batch_no int, collection_id uuid);
CREATE TABLE fin_s14_cases(collection_id uuid, case_type text);
CREATE TABLE general_ledger(id uuid primary key default gen_random_uuid(), amount numeric, direction text, category text, user_id uuid, transaction_group_id uuid, ledger_scope text, reference_id text, idempotency_key text unique, source_id uuid,
 classification text, solvency_bypass_reason solvency_bypass_reason, source_table text, rent_request_id uuid, description text, recipient_type text, wallet_bucket text, created_at timestamptz default now());
CREATE TABLE rent_requests(id uuid primary key, amount_repaid numeric, total_repayment numeric, status text);
CREATE TABLE wallets(user_id uuid primary key, withdrawable_balance numeric, float_balance numeric, holds numeric);
CREATE TABLE audit_logs(user_id uuid, action_type text, table_name text, record_id text, reason text, metadata jsonb);
CREATE TABLE system_events(event_type text, user_id uuid, related_entity_type text, related_entity_id uuid, metadata jsonb);
CREATE TABLE cfo_approval_approvers(user_id uuid);
INSERT INTO cfo_approval_approvers VALUES ('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b');
CREATE FUNCTION is_cfo_approver(u uuid) RETURNS boolean LANGUAGE sql AS 'SELECT EXISTS(SELECT 1 FROM cfo_approval_approvers WHERE user_id=u)';
CREATE FUNCTION get_user_available_balance(u uuid) RETURNS numeric LANGUAGE sql AS 'SELECT greatest(0, withdrawable_balance - holds) FROM wallets WHERE user_id=u';
-- wallet movement stand-in for apply_wallet_movement
CREATE FUNCTION mv() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.ledger_scope='wallet' THEN UPDATE wallets SET withdrawable_balance = withdrawable_balance + CASE WHEN NEW.direction='cash_in' THEN NEW.amount ELSE -NEW.amount END WHERE user_id=NEW.user_id; END IF; RETURN NEW; END $$;
CREATE TRIGGER mv AFTER INSERT ON general_ledger FOR EACH ROW EXECUTE FUNCTION mv();
\copy agent_collections FROM 'ac.csv' CSV
\copy fin_s14_batch_cases FROM 'bc.csv' CSV
\copy fin_s14_cases FROM 'cs.csv' CSV
\copy general_ledger(id,amount,direction,category,user_id,transaction_group_id,ledger_scope,reference_id,idempotency_key,source_id) FROM 'gl.csv' CSV
\copy rent_requests FROM 'rr.csv' CSV
\copy wallets FROM 'w.csv' CSV
