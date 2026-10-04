 import { useEffect, useState } from 'react';
 import { supabase } from '@/integrations/supabase/client';
 import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
 import { Button } from '@/components/ui/button';
 import { Badge } from '@/components/ui/badge';
 import { Skeleton } from '@/components/ui/skeleton';
 import { MapPin, RefreshCw, Building2, Phone, Navigation, Loader2 } from 'lucide-react';
 import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
 import L from 'leaflet';
 import 'leaflet/dist/leaflet.css';
 import { toast } from 'sonner';
 
 // Fix for default marker icons in react-leaflet
 delete (L.Icon.Default.prototype as any)._getIconUrl;
 L.Icon.Default.mergeOptions({
   iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
   iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
   shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
 });
 
 // Custom icons
 const verifiedIcon = new L.Icon({
   iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
   shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
   iconSize: [25, 41],
   iconAnchor: [12, 41],
   popupAnchor: [1, -34],
   shadowSize: [41, 41]
 });
 
 const unverifiedIcon = new L.Icon({
   iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-orange.png',
   shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
   iconSize: [25, 41],
   iconAnchor: [12, 41],
   popupAnchor: [1, -34],
   shadowSize: [41, 41]
 });
 
 interface Landlord {
   id: string;
   name: string;
   phone: string;
   property_address: string;
   latitude: number | null;
   longitude: number | null;
   verified: boolean | null;
   number_of_houses: number | null;
   monthly_rent: number | null;
 }
 
 // Component to fit map bounds to markers
 function FitBounds({ landlords }: { landlords: Landlord[] }) {
   const map = useMap();
   
   useEffect(() => {
     const validLocations = landlords.filter(l => l.latitude && l.longitude);
     if (validLocations.length > 0) {
       const bounds = L.latLngBounds(
         validLocations.map(l => [l.latitude!, l.longitude!] as [number, number])
       );
       map.fitBounds(bounds, { padding: [50, 50] });
     }
   }, [landlords, map]);
   
   return null;
 }
 
 export default function LandlordLocationsMap() {
   const [landlords, setLandlords] = useState<Landlord[]>([]);
   const [loading, setLoading] = useState(true);
 
   const fetchLandlords = async () => {
     setLoading(true);
     try {
       const { data, error } = await supabase
         .from('landlords')
         .select('id, name, phone, property_address, latitude, longitude, verified, number_of_houses, monthly_rent')
         .not('latitude', 'is', null)
         .not('longitude', 'is', null)
         .order('created_at', { ascending: false });
 
       if (error) throw error;
       setLandlords(data || []);
     } catch (error: any) {
       toast.error('Failed to fetch landlord locations');
       console.error(error);
     } finally {
       setLoading(false);
     }
   };
 
   useEffect(() => {
     fetchLandlords();
   }, []);
 
   const openInGoogleMaps = (lat: number, lng: number) => {
     window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
   };
 
   const stats = {
     total: landlords.length,
     verified: landlords.filter(l => l.verified).length,
     unverified: landlords.filter(l => !l.verified).length,
   };
 
   // Default center (Uganda - Kampala)
   const defaultCenter: [number, number] = [0.3476, 32.5825];
 
   return (
     <Card>
       <CardHeader className="pb-3">
         <div className="flex items-center justify-between">
           <CardTitle className="text-lg flex items-center gap-2">
             <MapPin className="h-5 w-5 text-primary" />
             Property Locations
           </CardTitle>
           <Button variant="outline" size="sm" onClick={fetchLandlords} disabled={loading}>
             <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
             Refresh
           </Button>
         </div>
 
         {/* Stats */}
         <div className="grid grid-cols-3 gap-2 mt-3">
           <div className="p-2 rounded-lg bg-primary/10 text-center">
             <p className="text-lg font-bold text-primary">{stats.total}</p>
             <p className="text-xs text-muted-foreground">Properties</p>
           </div>
           <div className="p-2 rounded-lg bg-success/10 text-center">
             <p className="text-lg font-bold text-success">{stats.verified}</p>
             <p className="text-xs text-muted-foreground">Verified</p>
           </div>
           <div className="p-2 rounded-lg bg-warning/10 text-center">
             <p className="text-lg font-bold text-warning">{stats.unverified}</p>
             <p className="text-xs text-muted-foreground">Pending</p>
           </div>
         </div>
       </CardHeader>
 
       <CardContent>
         {loading ? (
           <Skeleton className="h-[400px] w-full rounded-lg" />
         ) : landlords.length === 0 ? (
           <div className="h-[400px] flex items-center justify-center bg-muted/30 rounded-lg">
             <div className="text-center">
               <Building2 className="h-12 w-12 mx-auto text-muted-foreground/30 mb-2" />
               <p className="text-muted-foreground">No property locations captured yet</p>
               <p className="text-xs text-muted-foreground mt-1">
                 Locations are captured when agents register landlords
               </p>
             </div>
           </div>
         ) : (
           <div className="h-[400px] rounded-lg overflow-hidden border">
             <MapContainer
               center={defaultCenter}
               zoom={7}
               style={{ height: '100%', width: '100%' }}
               scrollWheelZoom={true}
             >
               <TileLayer
                 attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                 url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
               />
               <FitBounds landlords={landlords} />
               {landlords.map((landlord) => (
                 <Marker
                   key={landlord.id}
                   position={[landlord.latitude!, landlord.longitude!]}
                   icon={landlord.verified ? verifiedIcon : unverifiedIcon}
                 >
                   <Popup>
                     <div className="min-w-[200px] p-1">
                       <div className="flex items-center justify-between mb-2">
                         <h3 className="font-semibold text-sm">{landlord.name}</h3>
                         {landlord.verified ? (
                           <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                             Verified
                           </span>
                         ) : (
                           <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">
                             Pending
                           </span>
                         )}
                       </div>
                       <div className="space-y-1 text-xs text-muted-foreground">
                         <p className="flex items-center gap-1">
                           <Phone className="h-3 w-3" />
                           {landlord.phone}
                         </p>
                         <p className="flex items-start gap-1">
                           <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
                           <span className="line-clamp-2">{landlord.property_address}</span>
                         </p>
                         {landlord.number_of_houses && (
                           <p className="flex items-center gap-1">
                             <Building2 className="h-3 w-3" />
                             {landlord.number_of_houses} house{landlord.number_of_houses > 1 ? 's' : ''}
                           </p>
                         )}
                       </div>
                       <button
                         onClick={() => openInGoogleMaps(landlord.latitude!, landlord.longitude!)}
                         className="mt-2 w-full text-xs py-1.5 px-2 bg-blue-500 text-white rounded flex items-center justify-center gap-1 hover:bg-blue-600 transition-colors"
                       >
                         <Navigation className="h-3 w-3" />
                         Open in Google Maps
                       </button>
                     </div>
                   </Popup>
                 </Marker>
               ))}
             </MapContainer>
           </div>
         )}
 
         {/* Legend */}
         <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
           <div className="flex items-center gap-1">
             <div className="w-3 h-3 rounded-full bg-green-500" />
             <span>Verified</span>
           </div>
           <div className="flex items-center gap-1">
             <div className="w-3 h-3 rounded-full bg-orange-500" />
             <span>Pending</span>
           </div>
         </div>
       </CardContent>
     </Card>
   );
 }