import type { RentDeskOrder } from '@/hooks/useRentDeskOrder';

/**
 * How the CFO payout desk (RentDisbursementQueue) lays out its rows: grouped by agent, so one tenant, a few or all of an agent's
 * tenants can be picked at a glance.
 *
 * With the server's order (rent_request_desk_order: best payers first by default, or newest / oldest) every agent's tenants are
 * listed in that rank, and the agents are listed by their best-ranked tenant, so good-paying tenants are at the top of the queue
 * and the CFO meets them first. Without it (still loading, or the call failed) the desk keeps exactly its previous layout: the
 * agent with the newest request first, and each agent's newest request first. With the "newest" sort the two layouts are the
 * same. This only orders rows: which rows are shown, what can be selected and every payment step are untouched.
 */
export interface PayoutGroupRow {
  id: string;
  created_at: string;
  agent_id: string | null;
  assigned_agent_id: string | null;
  agent_name: string;
}

export interface PayoutGroup<T> {
  agent_id: string;
  agent_name: string;
  rows: T[];
  /** Newest request time among the rows (ms). */
  latest: number;
}

const time = (iso: string) => new Date(iso).getTime();

export function groupPayoutRows<T extends PayoutGroupRow>(rows: T[], order?: RentDeskOrder): PayoutGroup<T>[] {
  const map = new Map<string, PayoutGroup<T>>();
  for (const it of rows) {
    const key = it.assigned_agent_id || it.agent_id || 'unassigned';
    const ts = time(it.created_at);
    const g = map.get(key) ?? { agent_id: key, agent_name: it.agent_name, rows: [], latest: 0 };
    g.rows.push(it);
    if (ts > g.latest) g.latest = ts;
    map.set(key, g);
  }

  const useServerOrder = !!order && order.byId.size > 0;
  const rankOf = (id: string) => order?.byId.get(id)?.rank;
  const newestFirst = (a: T, b: T) => time(b.created_at) - time(a.created_at);

  for (const g of map.values()) {
    if (!useServerOrder) {
      g.rows.sort(newestFirst);
      continue;
    }
    g.rows.sort((a, b) => {
      const ra = rankOf(a.id);
      const rb = rankOf(b.id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return newestFirst(a, b);
    });
  }

  const groups = [...map.values()];
  if (!useServerOrder) return groups.sort((a, b) => b.latest - a.latest);

  const best = (g: PayoutGroup<T>) => g.rows.reduce<number>((m, r) => Math.min(m, rankOf(r.id) ?? Infinity), Infinity);
  return groups.sort((a, b) => {
    const ba = best(a);
    const bb = best(b);
    if (ba !== bb) return ba - bb; // unranked-only groups (Infinity) fall to the end
    return b.latest - a.latest;
  });
}
