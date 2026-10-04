import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

interface LocationData {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  address?: string;
  city?: string;
  country?: string;
}

export function useLocationTracking() {
  const { user } = useAuth();
  const [location, setLocation] = useState<LocationData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const captureLocation = useCallback(async () => {
    if (!user) return;
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by your browser');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 60000 // Cache for 1 minute
        });
      });

      const locationData: LocationData = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy
      };

      // Determine location from coordinates - Uganda is roughly lat -1.5 to 4.2, lon 29.5 to 35.0
      const lat = locationData.latitude;
      const lon = locationData.longitude;
      const isUganda = lat >= -1.5 && lat <= 4.2 && lon >= 29.5 && lon <= 35.0;
      
      if (isUganda) {
        locationData.country = 'Uganda';
        // Simple region detection based on coordinates
        if (lat >= 0.2 && lat <= 0.4 && lon >= 32.4 && lon <= 32.7) {
          locationData.city = 'Kampala';
        } else if (lat >= 0.4 && lat <= 0.6 && lon >= 32.5 && lon <= 32.7) {
          locationData.city = 'Wakiso';
        } else if (lat >= -0.1 && lat <= 0.1 && lon >= 32.4 && lon <= 32.7) {
          locationData.city = 'Entebbe';
        } else {
          // Fallback: try reverse geocoding but validate the result
          try {
            const response = await fetch(
              `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`,
              { headers: { 'Accept-Language': 'en' } }
            );
            if (response.ok) {
              const data = await response.json();
              const geocodedCountry = data.address?.country;
              // Only use result if it correctly identifies Uganda
              if (geocodedCountry === 'Uganda') {
                locationData.city = data.address?.city || data.address?.town || data.address?.village || data.address?.county;
              }
            }
          } catch (geocodeError) {
            console.warn('Geocoding failed:', geocodeError);
          }
        }
      }

      // Save to database
      const { error: insertError } = await supabase
        .from('user_locations')
        .insert({
          user_id: user.id,
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          accuracy: locationData.accuracy,
          address: locationData.address,
          city: locationData.city,
          country: locationData.country
        });

      if (insertError) throw insertError;

      setLocation(locationData);
      setPermissionDenied(false);
    } catch (err: any) {
      if (err.code === 1) {
        setPermissionDenied(true);
        setError('Location permission denied');
      } else if (err.code === 2) {
        setError('Location unavailable');
      } else if (err.code === 3) {
        setError('Location request timed out');
      } else {
        setError(err.message || 'Failed to get location');
      }
      console.error('Location error:', err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Auto-capture: hourly if always-on GPS opt-in, otherwise every 12h
  useEffect(() => {
    if (!user) return;

    let intervalMs = 12 * 60 * 60 * 1000;
    let cancelled = false;

    (async () => {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('always_share_location')
          .eq('id', user.id)
          .maybeSingle();
        if (!cancelled && (data as any)?.always_share_location) {
          intervalMs = 60 * 60 * 1000; // 1h when opted-in
        }
      } catch {}
    })();

    const initialTimer = setTimeout(() => { captureLocation(); }, 5000);
    const intervalId = setInterval(() => { captureLocation(); }, intervalMs);

    return () => {
      cancelled = true;
      clearTimeout(initialTimer);
      clearInterval(intervalId);
    };
  }, [user, captureLocation]);

  return {
    location,
    loading,
    error,
    permissionDenied,
    captureLocation
  };
}
