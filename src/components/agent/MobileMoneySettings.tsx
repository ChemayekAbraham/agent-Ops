import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Phone, Check, Edit2 } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';

export function MobileMoneySettings() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [mobileNumber, setMobileNumber] = useState('');
  const [provider, setProvider] = useState<'MTN' | 'Airtel'>('MTN');
  const [savedNumber, setSavedNumber] = useState('');
  const [savedProvider, setSavedProvider] = useState<'MTN' | 'Airtel' | null>(null);

  useEffect(() => {
    fetchSettings();
  }, [user?.id]);

  const fetchSettings = async () => {
    if (!user) return;
    setLoading(true);
    
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('mobile_money_number, mobile_money_provider')
        .eq('id', user.id)
        .single();

      if (error) throw error;

      if (data?.mobile_money_number) {
        setSavedNumber(data.mobile_money_number);
        setMobileNumber(data.mobile_money_number);
      }
      if (data?.mobile_money_provider) {
        setSavedProvider(data.mobile_money_provider as 'MTN' | 'Airtel');
        setProvider(data.mobile_money_provider as 'MTN' | 'Airtel');
      }
    } catch (error) {
      console.error('Error fetching mobile money settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!user) return;
    
    const trimmedNumber = mobileNumber.trim();
    if (!trimmedNumber) {
      toast({ title: 'Please enter your mobile money number', variant: 'destructive' });
      return;
    }

    // Basic phone validation
    if (!/^0[0-9]{9}$/.test(trimmedNumber) && !/^\+256[0-9]{9}$/.test(trimmedNumber)) {
      toast({ title: 'Please enter a valid Uganda phone number', variant: 'destructive' });
      return;
    }

    hapticTap();
    setSaving(true);

    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          mobile_money_number: trimmedNumber,
          mobile_money_provider: provider
        })
        .eq('id', user.id);

      if (error) throw error;

      setSavedNumber(trimmedNumber);
      setSavedProvider(provider);
      setEditing(false);
      toast({ title: 'Mobile money details saved!' });
    } catch (error: any) {
      toast({ title: 'Failed to save', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setMobileNumber(savedNumber);
    setProvider(savedProvider || 'MTN');
    setEditing(false);
  };

  if (loading) {
    return (
      <Card className="border-border/50">
        <CardContent className="p-4 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Phone className="h-4 w-4 text-primary" />
          Commission Payout Number
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!savedNumber || editing ? (
          <>
            <div className="space-y-2">
              <Label className="text-sm">Mobile Money Provider</Label>
              <RadioGroup
                value={provider}
                onValueChange={(v) => setProvider(v as 'MTN' | 'Airtel')}
                className="grid grid-cols-2 gap-3"
              >
                <Label
                  htmlFor="mtn"
                  className={`flex items-center gap-2.5 rounded-xl border-2 p-3 cursor-pointer transition-all touch-manipulation ${
                    provider === 'MTN'
                      ? 'border-yellow-500 bg-yellow-500/15 shadow-sm'
                      : 'border-border bg-muted/30'
                  }`}
                >
                  <RadioGroupItem value="MTN" id="mtn" className="shrink-0" />
                  <div className="min-w-0">
                    <span className="block text-sm font-bold text-yellow-600">MTN</span>
                    <span className="block text-[11px] text-muted-foreground">MTN MoMo</span>
                  </div>
                </Label>
                <Label
                  htmlFor="airtel"
                  className={`flex items-center gap-2.5 rounded-xl border-2 p-3 cursor-pointer transition-all touch-manipulation ${
                    provider === 'Airtel'
                      ? 'border-red-500 bg-red-500/15 shadow-sm'
                      : 'border-border bg-muted/30'
                  }`}
                >
                  <RadioGroupItem value="Airtel" id="airtel" className="shrink-0" />
                  <div className="min-w-0">
                    <span className="block text-sm font-bold text-red-600">Airtel</span>
                    <span className="block text-[11px] text-muted-foreground">Airtel Money</span>
                  </div>
                </Label>
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label htmlFor="momo-number" className="text-sm">Phone Number</Label>
              <Input
                id="momo-number"
                type="tel"
                placeholder="e.g. 0770123456"
                value={mobileNumber}
                onChange={(e) => setMobileNumber(e.target.value)}
                className="h-12 text-base"
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                This is where your commissions will be sent
              </p>
            </div>

            <div className="flex gap-2">
              {editing && (
                <Button
                  variant="outline"
                  onClick={handleCancel}
                  disabled={saving}
                  className="flex-1 h-12"
                >
                  Cancel
                </Button>
              )}
              <Button
                onClick={handleSave}
                disabled={saving || !mobileNumber.trim()}
                className="flex-1 h-12"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${savedProvider === 'MTN' ? 'bg-yellow-500/20' : 'bg-red-500/20'}`}>
                <Phone className={`h-5 w-5 ${savedProvider === 'MTN' ? 'text-yellow-600' : 'text-red-600'}`} />
              </div>
              <div>
                <p className="font-semibold">{savedNumber}</p>
                <p className={`text-xs font-medium ${savedProvider === 'MTN' ? 'text-yellow-600' : 'text-red-600'}`}>
                  {savedProvider} Mobile Money
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                hapticTap();
                setEditing(true);
              }}
              className="h-10 w-10"
            >
              <Edit2 className="h-4 w-4" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
