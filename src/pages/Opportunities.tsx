import { useNavigate } from 'react-router-dom';
import { roleToSlug } from '@/lib/roleRoutes';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Helmet } from 'react-helmet-async';

export default function Opportunities() {
  const navigate = useNavigate();

  return (
    <>
      <Helmet>
        <link rel="canonical" href="https://welileapp.com/opportunities" />
        <meta property="og:url" content="https://welileapp.com/opportunities" />
      </Helmet>
    <div className="min-h-screen bg-background flex flex-col">
      <div className="sticky top-0 z-40 bg-background border-b border-border/50 px-4 py-3 flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate('/dashboard/tenant')}
          className="shrink-0"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-lg font-bold text-foreground">Opportunities</h1>
      </div>
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="text-center space-y-2">
          <p className="text-2xl">🏘️</p>
          <p className="font-semibold text-foreground">View opportunities on your dashboard</p>
          <p className="text-sm text-muted-foreground">
            Tap the Opportunities card on your home screen to explore available houses.
          </p>
          <Button variant="outline" className="mt-4" onClick={() => navigate('/dashboard/tenant')}>
            Go to Dashboard
          </Button>
        </div>
      </div>
    </div>
    </>
  );
}
