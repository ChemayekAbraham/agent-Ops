drop policy if exists "wallet_statements_own_select" on storage.objects;
create policy "wallet_statements_own_select"
on storage.objects for select to authenticated
using (bucket_id = 'wallet-statements' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "wallet_statements_own_insert" on storage.objects;
create policy "wallet_statements_own_insert"
on storage.objects for insert to authenticated
with check (bucket_id = 'wallet-statements' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "wallet_statements_own_update" on storage.objects;
create policy "wallet_statements_own_update"
on storage.objects for update to authenticated
using (bucket_id = 'wallet-statements' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'wallet-statements' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "wallet_statements_own_delete" on storage.objects;
create policy "wallet_statements_own_delete"
on storage.objects for delete to authenticated
using (bucket_id = 'wallet-statements' and (storage.foldername(name))[1] = auth.uid()::text);