import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { MapPin, Loader2, CheckCircle, XCircle, Navigation } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function ShareLocation() {
  const [params] = useSearchParams();
  const token = params.get('token');

  const [status, setStatus] = useState<'loading' | 'ready' | 'capturing' | 'success' | 'error' | 'expired' | 'invalid'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!token) { setStatus('invalid'); return; }
    // Check if token is valid and still pending
    supabase
      .from('location_requests')
      .select('id, status')
      .eq('token', token)
      .single()
      .then(({ data, error }) => {
        if (error || !data) setStatus('invalid');
        else if (data.status === 'captured') setStatus('expired');
        else setStatus('ready');
      });
  }, [token]);

  const handleShare = () => {
    if (!token) return;
    setStatus('capturing');

    if (!navigator.geolocation) {
      setErrorMsg('Your browser does not support location services.');
      setStatus('error');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        // The token is validated server-side inside the SECURITY DEFINER
        // `capture_location_by_token` function, so anonymous clients can only
        // fill in the coordinates of the exact pending request their secret
        // link belongs to.
        const { data, error } = await supabase.rpc('capture_location_by_token', {
          p_token: token,
          p_latitude: latitude,
          p_longitude: longitude,
          p_accuracy: accuracy ?? null,
        });

        if (error || data !== true) {
          setErrorMsg('Failed to save location. Please try again.');
          setStatus('error');
        } else {
          setStatus('success');
        }
      },
      (err) => {
        setErrorMsg(
          err.code === 1
            ? 'Location permission denied. Please allow location access and try again.'
            : 'Could not get your location. Please try again.'
        );
        setStatus('error');
      },
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }
    );
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm text-center space-y-6">
        <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
          <MapPin className="h-8 w-8 text-primary" />
        </div>

        <h1 className="text-xl font-bold">Share Your Location</h1>

        {status === 'loading' && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {status === 'invalid' && (
          <div className="space-y-2">
            <XCircle className="h-12 w-12 text-destructive mx-auto" />
            <p className="text-muted-foreground">This link is invalid or has expired.</p>
          </div>
        )}

        {status === 'expired' && (
          <div className="space-y-2">
            <CheckCircle className="h-12 w-12 text-success mx-auto" />
            <p className="text-muted-foreground">Location has already been shared. Thank you!</p>
          </div>
        )}

        {status === 'ready' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Welile is requesting your current location to verify your address for a rent request. Tap the button below to share.
            </p>
            <Button onClick={handleShare} size="lg" className="w-full gap-2">
              <Navigation className="h-5 w-5" />
              Share My Location
            </Button>
          </div>
        )}

        {status === 'capturing' && (
          <div className="space-y-3 py-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
            <p className="text-sm text-muted-foreground">Getting your location...</p>
          </div>
        )}

        {status === 'success' && (
          <div className="space-y-2">
            <CheckCircle className="h-12 w-12 text-success mx-auto" />
            <p className="font-semibold text-success">Location shared successfully!</p>
            <p className="text-xs text-muted-foreground">You can close this page now.</p>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-3">
            <XCircle className="h-12 w-12 text-destructive mx-auto" />
            <p className="text-sm text-destructive">{errorMsg}</p>
            <Button onClick={() => setStatus('ready')} variant="outline">
              Try Again
            </Button>
          </div>
        )}

        <p className="text-[10px] text-muted-foreground/50 pt-4">
          Powered by Welile · Your location is only used for rent verification
        </p>
      </div>
    </div>
  );
}
