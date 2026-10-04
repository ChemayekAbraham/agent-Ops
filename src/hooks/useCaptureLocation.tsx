 import { useState, useCallback } from 'react';
 
 interface LocationData {
   latitude: number;
   longitude: number;
   accuracy: number | null;
 }
 
 interface UseCaptureLocationReturn {
   location: LocationData | null;
   loading: boolean;
   error: string | null;
   captureLocation: () => Promise<LocationData | null>;
 }
 
 export function useCaptureLocation(): UseCaptureLocationReturn {
   const [location, setLocation] = useState<LocationData | null>(null);
   const [loading, setLoading] = useState(false);
   const [error, setError] = useState<string | null>(null);
 
   const captureLocation = useCallback(async (): Promise<LocationData | null> => {
     if (!navigator.geolocation) {
       setError('Geolocation not supported');
       return null;
     }
 
     setLoading(true);
     setError(null);
 
     try {
       const position = await new Promise<GeolocationPosition>((resolve, reject) => {
         navigator.geolocation.getCurrentPosition(resolve, reject, {
           enableHighAccuracy: true,
           timeout: 15000,
           maximumAge: 0,
         });
       });
 
       const locationData: LocationData = {
         latitude: position.coords.latitude,
         longitude: position.coords.longitude,
         accuracy: position.coords.accuracy,
       };
 
       setLocation(locationData);
       return locationData;
     } catch (err: any) {
       if (err.code === 1) {
         setError('Location permission denied');
       } else if (err.code === 2) {
         setError('Location unavailable');
       } else if (err.code === 3) {
         setError('Location request timed out');
       } else {
         setError('Failed to get location');
       }
       return null;
     } finally {
       setLoading(false);
     }
   }, []);
 
   return { location, loading, error, captureLocation };
 }