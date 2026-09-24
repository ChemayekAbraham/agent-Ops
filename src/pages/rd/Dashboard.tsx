import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CommandStrip } from '@/components/rd/CommandStrip';
import { Pipeline } from '@/components/rd/Pipeline';
import { MissionDetail } from '@/components/rd/MissionDetail';
import { DecisionLog } from '@/components/rd/DecisionLog';

const tabCls = ({ isActive }: { isActive: boolean }) =>
  cn('rounded-md px-3 py-1.5 text-sm font-medium', isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted');

export default function RDDashboard() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 py-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="gap-1.5 px-2" onClick={() => navigate('/admin/dashboard')}>
              <ArrowLeft className="h-4 w-4" />
              Back to dashboards
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <FlaskConical className="h-5 w-5 text-lime-700" />
              <h1 className="text-lg font-bold text-foreground">R&amp;D</h1>
            </div>
          </div>
          <nav className="mt-2 flex gap-1">
            <NavLink to="/rd" end className={tabCls}>Pipeline</NavLink>
            <NavLink to="/rd/log" className={tabCls}>Decision log</NavLink>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-4">
        <Routes>
          <Route index element={<><CommandStrip /><Pipeline /></>} />
          <Route path="missions/:id" element={<MissionDetail />} />
          <Route path="log" element={<DecisionLog />} />
        </Routes>
      </main>
    </div>
  );
}
