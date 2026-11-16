import { useQuery } from '@tanstack/react-query';
import { rpc } from './reviewApi';
import { LABEL, statusText } from './deskTheme';
import { fmt } from './format';
import { Card, ErrorLine, stackLayout } from './ui';
import { CallButtons, dayText } from './arrears/ArrearsParts';

/**
 * FAKE-FLAG (E124): agents with 3 or more requests discarded as fake in 30
 * days, from `fake_request_flags(p_days, p_min)`, for Agent Ops to call and
 * perhaps suspend. Hidden when nobody is flagged, while loading, and for a
 * viewer the server refuses.
 */

export const FAKE_DAYS = 30;
export const FAKE_MIN = 3;

export type FakeFlagAgent = { agent_id: string; name: string | null; phone: string | null; fakes: number; last_at: string | null; posted_in_window: number | null };

export function useFakeRequestFlags() {
  return useQuery({
    queryKey: ['desk-feed', 'fake-request-flags', FAKE_DAYS, FAKE_MIN],
    queryFn: async () => {
      const { data, error } = await rpc('fake_request_flags', { p_days: FAKE_DAYS, p_min: FAKE_MIN });
      if (error) throw error;
      const d = (data ?? {}) as { agents?: FakeFlagAgent[]; rule?: string };
      return { agents: Array.isArray(d.agents) ? d.agents : [], rule: d.rule ?? null };
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

const refused = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null;
  return x?.code === '42501' || /^FAKE_FLAGS_DENIED/.test(String(x?.message ?? ''));
};

export function FakeRequestFlagsCard({ board }: { board: boolean }) {
  const q = useFakeRequestFlags();
  if (q.isLoading) return null;
  if (q.error) return refused(q.error) ? null : <ErrorLine>{String((q.error as { message?: string }).message ?? q.error)}</ErrorLine>;
  const agents = q.data?.agents ?? [];
  if (agents.length === 0) return null;
  return (
    <Card board={board} title="Fake-request flags" hint={`${FAKE_MIN}+ discarded as fake in ${FAKE_DAYS} days`} ariaLabel="Fake-request flags" footnote={q.data?.rule ?? undefined}>
      <ul style={{ ...stackLayout(8), margin: 0, padding: 0, listStyle: 'none' }} data-fake-flags>
        {agents.map((a) => (
          <li key={a.agent_id} className="border-t border-[var(--desk-line-color)] pt-2 first:border-t-0 first:pt-0" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }} data-fake-agent={a.agent_id}>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <span className="text-sm font-semibold text-foreground">{a.name ?? '—'}</span>
              {a.phone && <span className="ml-2 font-mono text-xs text-muted-foreground">{a.phone}</span>}
              <span className="block text-sm">
                <span className={`font-semibold tabular-nums ${statusText.bad}`}>{fmt('int', a.fakes)} fake</span>
                <span className={LABEL}>
                  {' '}
                  · {fmt('int', a.posted_in_window)} posted in {FAKE_DAYS} days · last {dayText(a.last_at)}
                </span>
              </span>
            </span>
            <CallButtons phone={a.phone} who={`agent ${a.name ?? ''}`.trim()} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
