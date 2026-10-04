import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { 
  Building2, User, Phone, MapPin, Banknote, Edit2, Save, X, 
  Plus, Trash2, CheckCircle2, Loader2, Navigation, ShieldCheck,
  Droplets, Zap, Star
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
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
import RegisterLandlordDialog from './RegisterLandlordDialog';

interface Landlord {
  id: string;
  name: string;
  phone: string;
  property_address: string;
  monthly_rent: number | null;
  mobile_money_number: string | null;
  mobile_money_name: string | null;
  water_meter_number: string | null;
  electricity_meter_number: string | null;
  number_of_houses: number | null;
  house_category: string | null;
  latitude: number | null;
  longitude: number | null;
  verified: boolean | null;
  ready_to_receive: boolean | null;
}

// Calculate completeness score for a landlord record
function getCompletenessScore(l: Landlord): number {
  let score = 0;
  if (l.name) score += 10;
  if (l.phone) score += 10;
  if (l.property_address) score += 10;
  if (l.monthly_rent) score += 10;
  if (l.latitude && l.longitude) score += 15;
  if (l.mobile_money_name) score += 15;
  if (l.water_meter_number) score += 10;
  if (l.electricity_meter_number) score += 10;
  if (l.number_of_houses && l.number_of_houses > 0) score += 5;
  if (l.house_category) score += 5;
  return Math.min(score, 100);
}

export default function MyLandlordsSection() {
  const { user } = useAuth();
  const [landlords, setLandlords] = useState<Landlord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  
  const [editForm, setEditForm] = useState<Partial<Landlord>>({});

  useEffect(() => {
    if (user) fetchLandlords();
  }, [user]);

  const fetchLandlords = async () => {
    if (!user) return;
    
    const { data, error } = await supabase
      .from('landlords')
      .select('id, name, phone, property_address, monthly_rent, mobile_money_number, mobile_money_name, water_meter_number, electricity_meter_number, number_of_houses, house_category, latitude, longitude, verified, ready_to_receive')
      .eq('tenant_id', user.id)
      .order('created_at', { ascending: false });

    if (!error) setLandlords(data || []);
    setLoading(false);
  };

  const startEditing = (landlord: Landlord) => {
    setEditingId(landlord.id);
    setEditForm({
      name: landlord.name,
      phone: landlord.phone,
      property_address: landlord.property_address,
      monthly_rent: landlord.monthly_rent,
      mobile_money_number: landlord.mobile_money_number,
    });
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditForm({});
  };

  const saveEdit = async (landlordId: string) => {
    if (!editForm.name?.trim() || !editForm.phone?.trim() || !editForm.property_address?.trim()) {
      toast.error('Please fill in all required fields');
      return;
    }

    setSaving(true);
    
    const { error } = await supabase
      .from('landlords')
      .update({
        name: editForm.name.trim(),
        phone: editForm.phone.trim(),
        property_address: editForm.property_address.trim(),
        monthly_rent: editForm.monthly_rent || null,
        mobile_money_number: editForm.mobile_money_number?.trim() || null,
      })
      .eq('id', landlordId);

    setSaving(false);

    if (error) {
      toast.error('Failed to update landlord details');
      return;
    }

    toast.success('Landlord details updated');
    setEditingId(null);
    setEditForm({});
    fetchLandlords();
  };

  const deleteLandlord = async (landlordId: string) => {
    const { error } = await supabase
      .from('landlords')
      .delete()
      .eq('id', landlordId);

    if (error) {
      toast.error('Failed to delete landlord');
      return;
    }

    toast.success('Landlord removed');
    setLandlords(prev => prev.filter(l => l.id !== landlordId));
  };

  const getStatusBadge = (landlord: Landlord) => {
    if (landlord.ready_to_receive) {
      return (
        <Badge variant="outline" className="gap-1 bg-success/10 text-success border-success/30 text-[10px]">
          <ShieldCheck className="h-3 w-3" /> Ready
        </Badge>
      );
    }
    if (landlord.verified) {
      return (
        <Badge variant="outline" className="gap-1 bg-primary/10 text-primary border-primary/30 text-[10px]">
          <CheckCircle2 className="h-3 w-3" /> Verified
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="gap-1 bg-muted text-muted-foreground text-[10px]">
        Pending
      </Badge>
    );
  };

  if (loading) {
    return (
      <Card className="glass-card border-border/50 shadow-elevated overflow-hidden">
        <CardHeader>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-60" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-32 rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="glass-card border-border/50 shadow-elevated overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 via-transparent to-teal-500/5 pointer-events-none" />
        
        <CardHeader className="relative">
          <CardTitle className="flex items-center gap-2">
            <motion.div
              className="p-2 rounded-lg bg-emerald-500/10"
              whileHover={{ scale: 1.1, rotate: -5 }}
              transition={{ type: 'spring', stiffness: 400, damping: 17 }}
            >
              <Building2 className="h-5 w-5 text-emerald-500" />
            </motion.div>
            My Landlords
          </CardTitle>
          <CardDescription>
            More accurate info = higher rent qualification & faster approval
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4 relative">
          <AnimatePresence mode="popLayout">
            {landlords.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center py-8"
              >
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted/50 flex items-center justify-center">
                  <Building2 className="h-8 w-8 text-muted-foreground" />
                </div>
                <p className="text-muted-foreground mb-4">
                  No landlords registered yet
                </p>
                <Button onClick={() => setShowAddDialog(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Register Your Landlord
                </Button>
              </motion.div>
            ) : (
              <>
                {landlords.map((landlord, index) => {
                  const score = getCompletenessScore(landlord);
                  return (
                    <motion.div
                      key={landlord.id}
                      layout
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ delay: index * 0.1 }}
                      className="p-4 rounded-xl bg-background/50 border border-border/50"
                    >
                      {editingId === landlord.id ? (
                        <div className="space-y-4">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <Label className="text-xs flex items-center gap-1">
                                <User className="h-3 w-3" /> Name
                              </Label>
                              <Input
                                value={editForm.name || ''}
                                onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
                                className="h-9"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs flex items-center gap-1">
                                <Phone className="h-3 w-3" /> Phone
                              </Label>
                              <Input
                                value={editForm.phone || ''}
                                onChange={(e) => setEditForm(prev => ({ ...prev, phone: e.target.value }))}
                                className="h-9"
                              />
                            </div>
                          </div>
                          
                          <div className="space-y-1">
                            <Label className="text-xs flex items-center gap-1">
                              <MapPin className="h-3 w-3" /> Property Address
                            </Label>
                            <Input
                              value={editForm.property_address || ''}
                              onChange={(e) => setEditForm(prev => ({ ...prev, property_address: e.target.value }))}
                              className="h-9"
                            />
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <Label className="text-xs flex items-center gap-1">
                                <Banknote className="h-3 w-3" /> Monthly Rent (UGX)
                              </Label>
                              <Input
                                type="number"
                                value={editForm.monthly_rent || ''}
                                onChange={(e) => setEditForm(prev => ({ ...prev, monthly_rent: parseInt(e.target.value) || null }))}
                                className="h-9"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs flex items-center gap-1">
                                <Phone className="h-3 w-3" /> Mobile Money
                              </Label>
                              <Input
                                value={editForm.mobile_money_number || ''}
                                onChange={(e) => setEditForm(prev => ({ ...prev, mobile_money_number: e.target.value }))}
                                className="h-9"
                              />
                            </div>
                          </div>

                          <div className="flex gap-2 pt-2">
                            <Button variant="outline" size="sm" onClick={cancelEditing} className="flex-1">
                              <X className="h-4 w-4 mr-1" /> Cancel
                            </Button>
                            <Button size="sm" onClick={() => saveEdit(landlord.id)} disabled={saving} className="flex-1">
                              {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
                              Save
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex items-center gap-3">
                              <div className="p-2 rounded-lg bg-emerald-500/10">
                                <User className="h-4 w-4 text-emerald-500" />
                              </div>
                              <div>
                                <p className="font-medium">{landlord.name}</p>
                                <p className="text-xs text-muted-foreground flex items-center gap-1">
                                  <Phone className="h-3 w-3" /> {landlord.phone}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              {getStatusBadge(landlord)}
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEditing(landlord)}>
                                <Edit2 className="h-4 w-4" />
                              </Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive">
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Remove Landlord?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      This will remove {landlord.name} from your registered landlords.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => deleteLandlord(landlord.id)} className="bg-destructive hover:bg-destructive/90">
                                      Remove
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          </div>

                          {/* Info grid */}
                          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground mb-2">
                            <div className="flex items-start gap-1">
                              <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
                              <span>{landlord.property_address}</span>
                            </div>
                            {landlord.monthly_rent && (
                              <div className="flex items-center gap-1">
                                <Banknote className="h-3 w-3 shrink-0" />
                                <span>{formatUGX(landlord.monthly_rent)}/mo</span>
                              </div>
                            )}
                            {landlord.latitude && (
                              <div className="flex items-center gap-1">
                                <Navigation className="h-3 w-3 shrink-0 text-success" />
                                <span className="text-success">GPS ✓</span>
                              </div>
                            )}
                            {landlord.water_meter_number && (
                              <div className="flex items-center gap-1">
                                <Droplets className="h-3 w-3 shrink-0 text-blue-500" />
                                <span>NWSC ✓</span>
                              </div>
                            )}
                            {landlord.electricity_meter_number && (
                              <div className="flex items-center gap-1">
                                <Zap className="h-3 w-3 shrink-0 text-amber-500" />
                                <span>UEDCL ✓</span>
                              </div>
                            )}
                          </div>

                          {/* Qualification Score */}
                          <div className="mt-3 p-2 rounded-lg bg-muted/30 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Star className="h-4 w-4 text-primary shrink-0" />
                              <span className="text-xs font-medium">Qualification</span>
                            </div>
                            <span className={`text-xs font-bold ${
                              score >= 80 ? 'text-success' : score >= 50 ? 'text-amber-500' : 'text-destructive'
                            }`}>
                              {score}%
                            </span>
                          </div>

                          {landlord.monthly_rent && (
                            <div className="mt-2 p-2 rounded-lg bg-emerald-500/10 flex items-center gap-2">
                              <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                                Eligible for up to {formatUGX(landlord.monthly_rent * 0.7)} discount
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </motion.div>
                  );
                })}

                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
                  <Button variant="outline" className="w-full gap-2 border-dashed" onClick={() => setShowAddDialog(true)}>
                    <Plus className="h-4 w-4" /> Add Another Landlord
                  </Button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>

      <RegisterLandlordDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onSuccess={fetchLandlords}
      />
    </>
  );
}
