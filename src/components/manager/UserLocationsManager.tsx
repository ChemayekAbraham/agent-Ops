import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { 
  MapPin, 
  CheckCircle2, 
  Search, 
  RefreshCw,
  User,
  Phone,
  Calendar,
  Navigation,
  ExternalLink,
  Clock,
  Shield,
  XCircle,
  Eye
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

interface UserLocation {
  id: string;
  user_id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  address: string | null;
  city: string | null;
  country: string | null;
  captured_at: string;
  verified: boolean;
  verified_by: string | null;
  verified_at: string | null;
  verification_notes: string | null;
  user?: {
    full_name: string;
    phone: string;
    email: string;
  };
}

export default function UserLocationsManager() {
  const { user } = useAuth();
  const [locations, setLocations] = useState<UserLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'verified' | 'unverified'>('all');
  const [selectedLocation, setSelectedLocation] = useState<UserLocation | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [verifyDialogOpen, setVerifyDialogOpen] = useState(false);
  const [verificationNotes, setVerificationNotes] = useState('');
  const [processing, setProcessing] = useState(false);

  const fetchLocations = async () => {
    setLoading(true);
    try {
      // Get locations with user profiles
      const { data: locationsData, error: locationsError } = await supabase
        .from('user_locations')
        .select('*')
        .order('captured_at', { ascending: false })
        .limit(100);

      if (locationsError) throw locationsError;

      // Get unique user IDs
      const userIds = [...new Set(locationsData?.map(l => l.user_id) || [])];
      
      // Fetch user profiles
      let profiles: Record<string, any> = {};
      if (userIds.length > 0) {
        const { data: profilesData } = await supabase
          .from('profiles')
          .select('id, full_name, phone, email')
          .in('id', userIds);
        
        profiles = (profilesData || []).reduce((acc, p) => {
          acc[p.id] = p;
          return acc;
        }, {} as Record<string, any>);
      }

      // Merge data
      const locationsWithUsers = (locationsData || []).map(loc => ({
        ...loc,
        user: profiles[loc.user_id]
      }));

      setLocations(locationsWithUsers);
    } catch (error: any) {
      toast.error('Failed to fetch locations');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLocations();
  }, []);

  const handleVerify = async (verified: boolean) => {
    if (!user || !selectedLocation) return;
    setProcessing(true);

    try {
      const { error } = await supabase
        .from('user_locations')
        .update({
          verified,
          verified_by: user.id,
          verified_at: new Date().toISOString(),
          verification_notes: verificationNotes || null
        })
        .eq('id', selectedLocation.id);

      if (error) throw error;

      toast.success(verified ? 'Location verified' : 'Location marked as unverified');
      setVerifyDialogOpen(false);
      setVerificationNotes('');
      fetchLocations();
      setDetailsOpen(false);
    } catch (error: any) {
      toast.error(error.message || 'Failed to update location');
    } finally {
      setProcessing(false);
    }
  };

  const openInMaps = (lat: number, lng: number) => {
    window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
  };

  const filteredLocations = locations.filter(loc => {
    // Filter by status
    if (filter === 'verified' && !loc.verified) return false;
    if (filter === 'unverified' && loc.verified) return false;

    // Filter by search
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
      loc.user?.full_name?.toLowerCase().includes(searchLower) ||
      loc.user?.phone?.includes(search) ||
      loc.address?.toLowerCase().includes(searchLower) ||
      loc.city?.toLowerCase().includes(searchLower)
    );
  });

  // Group locations by user (show latest per user)
  const latestByUser = filteredLocations.reduce((acc, loc) => {
    if (!acc[loc.user_id] || new Date(loc.captured_at) > new Date(acc[loc.user_id].captured_at)) {
      acc[loc.user_id] = loc;
    }
    return acc;
  }, {} as Record<string, UserLocation>);

  const uniqueUserLocations = Object.values(latestByUser);

  const stats = {
    total: locations.length,
    verified: locations.filter(l => l.verified).length,
    unverified: locations.filter(l => !l.verified).length,
    uniqueUsers: Object.keys(latestByUser).length
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            User Locations
          </CardTitle>
          <Button variant="outline" size="sm" onClick={fetchLocations} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-2 mt-3">
          <div className="p-2 rounded-lg bg-primary/10 text-center">
            <p className="text-lg font-bold text-primary">{stats.uniqueUsers}</p>
            <p className="text-xs text-muted-foreground">Users</p>
          </div>
          <div className="p-2 rounded-lg bg-muted text-center">
            <p className="text-lg font-bold">{stats.total}</p>
            <p className="text-xs text-muted-foreground">Total</p>
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

      <CardContent className="space-y-3">
        {/* Filters */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, phone, or location..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex gap-1">
            {(['all', 'unverified', 'verified'] as const).map(status => (
              <Button
                key={status}
                variant={filter === status ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilter(status)}
                className="capitalize"
              >
                {status}
              </Button>
            ))}
          </div>
        </div>

        {/* Locations List */}
        <ScrollArea className="h-[400px]">
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : uniqueUserLocations.length === 0 ? (
            <div className="text-center py-8">
              <MapPin className="h-12 w-12 mx-auto text-muted-foreground/30 mb-2" />
              <p className="text-muted-foreground">No locations found</p>
            </div>
          ) : (
            <div className="space-y-2">
              {uniqueUserLocations.map(loc => (
                <Card 
                  key={loc.id} 
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => {
                    setSelectedLocation(loc);
                    setDetailsOpen(true);
                  }}
                >
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <p className="font-medium truncate">{loc.user?.full_name || 'Unknown User'}</p>
                          {loc.verified ? (
                            <Badge className="bg-success/20 text-success border-0">
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                              Verified
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-warning/20 text-warning border-warning/30">
                              <Clock className="h-3 w-3 mr-1" />
                              Pending
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                          <Phone className="h-3 w-3" />
                          <span>{loc.user?.phone || 'No phone'}</span>
                        </div>
                        <div className="flex items-start gap-2 text-xs text-muted-foreground">
                          <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
                          <span className="line-clamp-2">
                            {loc.address || loc.city || `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`}
                          </span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(loc.captured_at), { addSuffix: true })}
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2 h-8"
                          onClick={(e) => {
                            e.stopPropagation();
                            openInMaps(loc.latitude, loc.longitude);
                          }}
                        >
                          <ExternalLink className="h-3 w-3 mr-1" />
                          Map
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>

      {/* Details Dialog */}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Location Details</DialogTitle>
          </DialogHeader>
          
          {selectedLocation && (
            <div className="space-y-4">
              {/* User Info */}
              <Card className="border-0 bg-muted/50">
                <CardContent className="p-3">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-primary/20 flex items-center justify-center">
                      <User className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="font-medium">{selectedLocation.user?.full_name || 'Unknown'}</p>
                      <p className="text-sm text-muted-foreground">{selectedLocation.user?.phone}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Status */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Verification Status</span>
                {selectedLocation.verified ? (
                  <Badge className="bg-success/20 text-success border-0">
                    <Shield className="h-3 w-3 mr-1" />
                    Verified
                  </Badge>
                ) : (
                  <Badge variant="outline" className="bg-warning/20 text-warning border-warning/30">
                    Pending Verification
                  </Badge>
                )}
              </div>

              {/* Location Details */}
              <div className="space-y-3">
                <div className="p-3 rounded-lg bg-muted/50">
                  <p className="text-xs text-muted-foreground mb-1">Address</p>
                  <p className="text-sm">{selectedLocation.address || 'No address available'}</p>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-lg bg-muted/50">
                    <p className="text-xs text-muted-foreground mb-1">Coordinates</p>
                    <p className="text-sm font-mono">
                      {selectedLocation.latitude.toFixed(6)}, {selectedLocation.longitude.toFixed(6)}
                    </p>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/50">
                    <p className="text-xs text-muted-foreground mb-1">Accuracy</p>
                    <p className="text-sm">
                      {selectedLocation.accuracy ? `±${Math.round(selectedLocation.accuracy)}m` : 'Unknown'}
                    </p>
                  </div>
                </div>

                {selectedLocation.city && (
                  <div className="p-3 rounded-lg bg-muted/50">
                    <p className="text-xs text-muted-foreground mb-1">City / Country</p>
                    <p className="text-sm">{selectedLocation.city}{selectedLocation.country ? `, ${selectedLocation.country}` : ''}</p>
                  </div>
                )}

                <div className="p-3 rounded-lg bg-muted/50">
                  <p className="text-xs text-muted-foreground mb-1">Captured</p>
                  <p className="text-sm">
                    {format(new Date(selectedLocation.captured_at), 'MMM d, yyyy • h:mm a')}
                  </p>
                </div>

                {selectedLocation.verified && selectedLocation.verified_at && (
                  <div className="p-3 rounded-lg bg-success/10 border border-success/20">
                    <p className="text-xs text-success mb-1">Verified</p>
                    <p className="text-sm text-success">
                      {format(new Date(selectedLocation.verified_at), 'MMM d, yyyy • h:mm a')}
                    </p>
                    {selectedLocation.verification_notes && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Notes: {selectedLocation.verification_notes}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => openInMaps(selectedLocation.latitude, selectedLocation.longitude)}
                >
                  <Navigation className="h-4 w-4 mr-2" />
                  Open in Maps
                </Button>
                <AlertDialog open={verifyDialogOpen} onOpenChange={setVerifyDialogOpen}>
                  <AlertDialogTrigger asChild>
                    <Button 
                      className="flex-1" 
                      variant={selectedLocation.verified ? "outline" : "default"}
                    >
                      {selectedLocation.verified ? (
                        <>
                          <XCircle className="h-4 w-4 mr-2" />
                          Unverify
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-4 w-4 mr-2" />
                          Verify
                        </>
                      )}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {selectedLocation.verified ? 'Unverify Location?' : 'Verify Location?'}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {selectedLocation.verified 
                          ? 'This will mark the location as unverified.'
                          : 'This will mark the location as verified by you.'}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="py-2">
                      <Textarea
                        placeholder="Add verification notes (optional)"
                        value={verificationNotes}
                        onChange={(e) => setVerificationNotes(e.target.value)}
                        rows={2}
                      />
                    </div>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction 
                        onClick={() => handleVerify(!selectedLocation.verified)}
                        disabled={processing}
                      >
                        {processing ? 'Processing...' : 'Confirm'}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
