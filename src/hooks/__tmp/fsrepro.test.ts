import { vi, test } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import fs from 'fs';
const d = JSON.parse(fs.readFileSync('/tmp/fs/data.json','utf8'));
vi.mock('@/integrations/supabase/client', () => {
  const chain = (table: string): any => { const res = { data: table==='ledger_account_map'?d.map:[], error: null };
    const p: any = new Proxy({}, { get(_, k) { if (k==='then') return (r: any)=>r(res); return () => p; } }); return p; };
  return { supabase: { from: chain, rpc: async (n: string) => n==='get_financial_statement_ledger_sums' ? { data: d.sums, error: null } : { data: {}, error: null } } };
});
import { useFinancialStatements } from '@/hooks/useFinancialStatements';
test('repro', async () => {
  const { result } = renderHook(() => useFinancialStatements());
  await act(async () => { try { await result.current.generate(); console.log('OK'); } catch (e: any) { console.log('ERR', e?.stack); } });
});
