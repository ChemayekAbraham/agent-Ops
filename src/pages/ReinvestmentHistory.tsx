import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ReinvestmentHistory as ReinvestmentHistoryView } from '@/components/supporter/ReinvestmentHistory';

export default function ReinvestmentHistory() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="font-bold text-base tracking-tight">Reinvestment History</h1>
      </div>
      <div className="p-4 max-w-lg mx-auto">
        <ReinvestmentHistoryView />
      </div>
    </div>
  );
}
