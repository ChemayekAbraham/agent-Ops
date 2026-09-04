import { useNavigate, useSearchParams } from 'react-router-dom';
import { LandlordOpsTodayView } from '@/components/executive/landlord-ops/LandlordOpsTodayView';

export default function Today() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  return (
    <LandlordOpsTodayView
      onNavigate={(path) => navigate(`/landlord-ops/${path}`)}
      // Router-owned, so the drawer opens and the URL stays shareable. A raw
      // history.pushState here would not re-render anything.
      onOpenDecision={(id) => {
        const next = new URLSearchParams(params);
        next.set('decide', id);
        setParams(next);
      }}
    />
  );
}
