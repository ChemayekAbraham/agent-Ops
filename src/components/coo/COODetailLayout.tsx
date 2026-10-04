import { ArrowLeft, Activity } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';

import { useAuth } from '@/hooks/useAuth';

type HealthStatus = 'green' | 'yellow' | 'red';

interface COODetailLayoutProps {
  title: string;
  subtitle: string;
  status?: HealthStatus;
  children: React.ReactNode;
}

function StatusDot({ status }: { status: HealthStatus }) {
  const colors = { green: 'bg-emerald-500', yellow: 'bg-amber-500', red: 'bg-red-500' };
  return <div className={cn('w-2.5 h-2.5 rounded-full', colors[status])} />;
}

export default function COODetailLayout({ title, subtitle, status = 'green', children }: COODetailLayoutProps) {
  const navigate = useNavigate();
  const { role } = useAuth();

  return (
    <div className="min-h-screen bg-background pb-24 lg:pb-8 lg:max-w-6xl lg:mx-auto">
      <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-lg border-b border-border">
        <div className="flex items-center gap-3 p-4">
          <button onClick={() => navigate('/coo-dashboard')} className="p-2 -ml-2 rounded-xl hover:bg-muted active:scale-95">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-black tracking-tight">{title}</h1>
              <StatusDot status={status} />
            </div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold">{subtitle}</p>
          </div>
        </div>
      </div>
      <div className="p-4 space-y-4">
        {children}
      </div>
      
    </div>
  );
}

export function KPICard({ label, value, sub, status }: { label: string; value: string | number; sub?: string; status?: HealthStatus }) {
  const borderColor = status === 'red' ? 'border-red-500/40' : status === 'yellow' ? 'border-amber-500/40' : 'border-emerald-500/40';
  const bgColor = status === 'red' ? 'bg-red-500/8' : status === 'yellow' ? 'bg-amber-500/8' : 'bg-emerald-500/8';
  return (
    <div className={cn('rounded-2xl border-2 p-4', borderColor, bgColor)}>
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{label}</p>
      <p className="text-2xl font-black tracking-tight mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground pt-2">{children}</h2>;
}

export function DataRow({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-muted/50">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn('text-sm font-bold', highlight && 'text-emerald-600')}>{value}</span>
    </div>
  );
}
