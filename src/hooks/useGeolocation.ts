import { useState, useEffect, useCallback } from 'react';

interface LocationData {
  country: string | null;
  city: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  loading: boolean;
  error: string | null;
  permissionStatus: 'granted' | 'denied' | 'prompt' | 'unsupported';
}

export function useGeolocation(useGPS: boolean = false): LocationData & { requestGPSPermission: () => Promise<boolean> } {
  const [location, setLocation] = useState<LocationData>({
    country: null,
    city: null,
    countryCode: null,
    latitude: null,
    longitude: null,
    loading: true,
    error: null,
    permissionStatus: 'prompt'
  });

  // Request GPS permission and get coordinates
  const requestGPSPermission = useCallback(async (): Promise<boolean> => {
    if (!navigator.geolocation) {
      setLocation(prev => ({ ...prev, permissionStatus: 'unsupported' }));
      return false;
    }

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords;
          setLocation(prev => ({
            ...prev,
            latitude,
            longitude,
            permissionStatus: 'granted'
          }));

          // Reverse geocode to get city/country
          try {
            const response = await fetch(
              `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`
            );
            if (response.ok) {
              const data = await response.json();
              setLocation(prev => ({
                ...prev,
                city: data.address?.city || data.address?.town || data.address?.village || prev.city,
                country: data.address?.country || prev.country,
                countryCode: data.address?.country_code?.toUpperCase() || prev.countryCode
              }));
            }
          } catch (e) {
            console.error('Reverse geocoding error:', e);
          }
          
          resolve(true);
        },
        (error) => {
          console.error('GPS error:', error);
          setLocation(prev => ({
            ...prev,
            permissionStatus: error.code === error.PERMISSION_DENIED ? 'denied' : 'prompt'
          }));
          resolve(false);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }, []);

  useEffect(() => {
    const fetchLocation = async () => {
      // If GPS is requested and available, try that first
      if (useGPS && navigator.geolocation) {
        try {
          const permResult = await navigator.permissions.query({ name: 'geolocation' });
          setLocation(prev => ({ ...prev, permissionStatus: permResult.state as any }));
          
          if (permResult.state === 'granted') {
            await requestGPSPermission();
          }
        } catch {
          // Permissions API not supported, will fall back to IP
        }
      }

      // Fallback to IP-based geolocation
      try {
        const response = await fetch('https://ipapi.co/json/');
        if (!response.ok) {
          throw new Error('Failed to fetch location');
        }
        const data = await response.json();
        
        setLocation(prev => ({
          ...prev,
          country: prev.country || data.country_name || null,
          city: prev.city || data.city || null,
          countryCode: prev.countryCode || data.country_code || null,
          latitude: prev.latitude || data.latitude || null,
          longitude: prev.longitude || data.longitude || null,
          loading: false,
          error: null
        }));
      } catch (error) {
        console.error('Geolocation error:', error);
        // Try fallback API
        try {
          const fallbackResponse = await fetch('https://ip-api.com/json/?fields=country,city,countryCode,lat,lon');
          if (fallbackResponse.ok) {
            const fallbackData = await fallbackResponse.json();
            setLocation(prev => ({
              ...prev,
              country: prev.country || fallbackData.country || null,
              city: prev.city || fallbackData.city || null,
              countryCode: prev.countryCode || fallbackData.countryCode || null,
              latitude: prev.latitude || fallbackData.lat || null,
              longitude: prev.longitude || fallbackData.lon || null,
              loading: false,
              error: null
            }));
            return;
          }
        } catch {
          // Fallback also failed
        }
        
        setLocation(prev => ({
          ...prev,
          loading: false,
          error: 'Could not determine location'
        }));
      }
    };

    fetchLocation();
  }, [useGPS, requestGPSPermission]);

  return { ...location, requestGPSPermission };
}

// Function to get location data (for use in non-hook contexts)
export async function getLocationData(): Promise<{ 
  country: string | null; 
  city: string | null; 
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
}> {
  try {
    const response = await fetch('https://ipapi.co/json/');
    if (!response.ok) throw new Error('Failed to fetch location');
    const data = await response.json();
    
    return {
      country: data.country_name || null,
      city: data.city || null,
      countryCode: data.country_code || null,
      latitude: data.latitude || null,
      longitude: data.longitude || null
    };
  } catch {
    try {
      const fallbackResponse = await fetch('https://ip-api.com/json/?fields=country,city,countryCode,lat,lon');
      if (fallbackResponse.ok) {
        const fallbackData = await fallbackResponse.json();
        return {
          country: fallbackData.country || null,
          city: fallbackData.city || null,
          countryCode: fallbackData.countryCode || null,
          latitude: fallbackData.lat || null,
          longitude: fallbackData.lon || null
        };
      }
    } catch {
      // Fallback also failed
    }
    
    return { country: null, city: null, countryCode: null, latitude: null, longitude: null };
  }
}

