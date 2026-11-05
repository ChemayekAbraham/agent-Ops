import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const GREEN = 'hsl(var(--success))';
const AMBER = 'hsl(var(--warning))';

export interface ProxyChartPoint { label: string; brought_in: number; pending: number }

/** The recharts graph on its own, so the library loads after the cards instead of before them. */
export function ProxyChartGraph({ data, max }: { data: ProxyChartPoint[]; max: number }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 6, right: 6, left: -26, bottom: 0 }}>
        <defs>
          <linearGradient id="biGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GREEN} stopOpacity={0.3} /><stop offset="100%" stopColor={GREEN} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="peGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={AMBER} stopOpacity={0.28} /><stop offset="100%" stopColor={AMBER} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={12} stroke="hsl(var(--muted-foreground))" />
        <YAxis allowDecimals={false} domain={[0, Math.ceil(max * 1.15)]} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
        <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} />
        <Area type="monotone" dataKey="brought_in" name="Brought In" stroke={GREEN} strokeWidth={2} fill="url(#biGrad)" dot={{ r: 2.5, fill: GREEN, strokeWidth: 0 }} activeDot={{ r: 4 }} />
        <Area type="monotone" dataKey="pending" name="Pending" stroke={AMBER} strokeWidth={2} fill="url(#peGrad)" dot={{ r: 2.5, fill: AMBER, strokeWidth: 0 }} activeDot={{ r: 4 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
