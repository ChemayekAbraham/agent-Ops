import { motion, useReducedMotion } from 'framer-motion';
import { UserAvatar } from '@/components/UserAvatar';
import { EliteRankBadge, ELITE_TIER_COLORS } from '@/components/agent/EliteRankBadge';
import { useEliteRanks } from '@/hooks/useEliteRanks';
import { EliteHowItWorksDialog } from '@/components/agent/EliteRankDialogs';

function Bar({ label, value, max, color, delay }: { label: string; value: number; max: number; color: string; delay: number }) {
  const reduce = useReducedMotion();
  const pct = Math.max(0, Math.min(100, (Number(value) / max) * 100));
  return (
    <div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{label}</span><span className="tabular-nums">{Number(value).toFixed(1)} / {max}</span>
      </div>
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuenow={Number(value)} aria-valuemax={max}>
        <motion.div className="h-full rounded-full" style={{ background: color }}
          initial={{ width: reduce ? `${pct}%` : 0 }} whileInView={{ width: `${pct}%` }} viewport={{ once: true }}
          transition={{ duration: 0.9, delay }} />
      </div>
    </div>
  );
}

export function EliteTop4Strip() {
  const { ranks } = useEliteRanks();
  const reduce = useReducedMotion();
  if (!ranks.length) return null;
  return (
    <section className="mb-6" aria-label="Elite Top 4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-foreground">Elite Top 4</h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Updated nightly at 1:00 AM Kampala time</span>
          <EliteHowItWorksDialog />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ranks.map((r, i) => {
          const c = ELITE_TIER_COLORS[r.tier_name];
          return (
            <motion.div key={r.agent_id} tabIndex={0}
              initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }} whileHover={reduce ? undefined : { y: -3 }}
              className="rounded-2xl border bg-card p-3 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
              style={{ borderColor: `${c.to}55` }}>
              <div className="flex items-center gap-3">
                <span className="w-6 text-sm font-black text-muted-foreground">#{r.rank_position}</span>
                <UserAvatar avatarUrl={r.avatar_url} fullName={r.full_name ?? 'Agent'} size="md" eliteTier={r.tier_name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{r.full_name ?? 'Agent'}</p>
                  <EliteRankBadge tier={r.tier_name} size="sm" />
                </div>
                <div className="text-right">
                  <p className="text-lg font-black tabular-nums text-foreground">{Number(r.composite_score).toFixed(1)}</p>
                  <p className="text-[10px] text-muted-foreground">score</p>
                </div>
              </div>
              <div className="mt-3 space-y-1.5">
                <Bar label="Collections" value={r.collection_score} max={40} color={c.to} delay={0.2 + i * 0.08} />
                <Bar label="Active sub-agents" value={r.network_score} max={35} color={c.to} delay={0.3 + i * 0.08} />
                <Bar label="App activity" value={r.activity_score} max={25} color={c.to} delay={0.4 + i * 0.08} />
              </div>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}
