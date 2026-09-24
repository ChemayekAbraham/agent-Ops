import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, FlaskConical } from 'lucide-react';

export default function RDDashboard() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate('/admin/dashboard')}
          >
            <ArrowLeft className="h-4 w-4" />
            Back to dashboards
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="flex items-center gap-3">
          <FlaskConical className="h-7 w-7 text-lime-700" />
          <h1 className="text-2xl font-bold text-foreground">R&amp;D</h1>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">Dashboard is being built.</p>
      </main>
    </div>
  );
}
