import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Ban, Loader2, Plus, Trash2, ShieldBan, Search } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

/**
 * Message types map to the `source` tag stamped on every outgoing SMS
 * (see sms_delivery_log.source). `all` blocks every type for that phone.
 */
export const SMS_MESSAGE_TYPES: { value: string; label: string }[] = [
  { value: 'all', label: 'All SMS (block everything)' },
  { value: 'daily_guarantee', label: 'Landlord Daily Guarantee' },
  { value: 'collection_reminder', label: 'Rent Collection Reminder' },
  { value: 'rent_access', label: 'Rent Access Limit' },
  { value: 'signup_invite', label: 'Signup Invite' },
  { value: 'viewing_confirmation', label: 'Viewing Confirmation' },
  { value: 'partner_broadcast', label: 'Partner Broadcast' },
  { value: 'otp', label: 'OTP / Login Code' },
  { value: 'password_reset', label: 'Password Reset' },
];

function typeLabel(value: string) {
  return SMS_MESSAGE_TYPES.find((t) => t.value === value)?.label || value;
}

type Exception = {
  id: string;
  phone: string;
  message_type: string;
  reason: string | null;
  created_at: string;
};

function normalizePhone(raw: string) {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}

export function SmsExceptionsManager() {
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [messageType, setMessageType] = useState('all');
  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');

  const { data: exceptions = [], isLoading } = useQuery({
    queryKey: ['sms-message-exceptions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sms_message_exceptions')
        .select('id, phone, message_type, reason, created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as Exception[];
    },
    staleTime: 30_000,
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const cleanPhone = normalizePhone(phone);
      if (!cleanPhone || cleanPhone.replace(/\D/g, '').length < 9) {
        throw new Error('Enter a valid phone number');
      }
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase.from('sms_message_exceptions').insert({
        phone: cleanPhone,
        message_type: messageType,
        reason: reason.trim() || null,
        created_by: userData.user?.id ?? null,
      });
      if (error) {
        if (error.code === '23505') throw new Error('This phone already has an exception for that message type');
        throw error;
      }
    },
    onSuccess: () => {
      toast.success('SMS exception added');
      setPhone('');
      setReason('');
      setMessageType('all');
      qc.invalidateQueries({ queryKey: ['sms-message-exceptions'] });
    },
    onError: (e: any) => toast.error(e.message || 'Could not add exception'),
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('sms_message_exceptions').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Exception removed');
      qc.invalidateQueries({ queryKey: ['sms-message-exceptions'] });
    },
    onError: (e: any) => toast.error(e.message || 'Could not remove exception'),
  });

  const filtered = exceptions.filter((e) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      e.phone.toLowerCase().includes(q) ||
      typeLabel(e.message_type).toLowerCase().includes(q) ||
      (e.reason || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldBan className="h-5 w-5 text-primary" />
        <div>
          <h2 className="text-lg font-bold">SMS Exceptions</h2>
          <p className="text-xs text-muted-foreground">
            Block a specific phone number from receiving a certain type of SMS.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="h-4 w-4" /> Add Exception
          </CardTitle>
          <CardDescription>
            The blocked phone will be skipped when that message type is sent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="exc-phone">Phone number</Label>
              <Input
                id="exc-phone"
                type="tel"
                inputMode="tel"
                placeholder="+256700000000"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Message type to block</Label>
              <Select value={messageType} onValueChange={setMessageType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SMS_MESSAGE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exc-reason">Reason (optional)</Label>
            <Input
              id="exc-reason"
              placeholder="e.g. Customer complaint / wrong number"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
            />
          </div>
          <Button onClick={() => addMutation.mutate()} disabled={addMutation.isPending} className="gap-1.5">
            {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
            Add Exception
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base">
            Active Exceptions <span className="text-muted-foreground font-normal">({exceptions.length})</span>
          </CardTitle>
          <div className="relative w-48">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
            />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {exceptions.length === 0 ? 'No SMS exceptions yet.' : 'No exceptions match your search.'}
            </p>
          ) : (
            <ScrollArea className="max-h-[480px]">
              <div className="space-y-2 pr-2">
                {filtered.map((exc) => (
                  <div
                    key={exc.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{exc.phone}</span>
                        <Badge variant="secondary" className="text-[11px]">
                          {typeLabel(exc.message_type)}
                        </Badge>
                      </div>
                      {exc.reason && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{exc.reason}</p>
                      )}
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Added {format(new Date(exc.created_at), 'dd MMM yyyy, HH:mm')}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-destructive hover:text-destructive"
                      onClick={() => removeMutation.mutate(exc.id)}
                      disabled={removeMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}