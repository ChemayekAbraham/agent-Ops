import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { PhoneCall, Loader2, Info, PhoneOutgoing, Clock, CheckCircle2, PhoneMissed } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { UserSearchPicker, type UserResult } from '@/components/cfo/UserSearchPicker';
import {
  useCallSessions, usePlaceCall, useAnnotateCall, useMyCallActivityToday,
  CALL_STATUS_LABEL, type CallSession, type CallStatus,
} from '@/hooks/useCallCentre';

/**
 * CRM Call Centre.
 *
 * The one thing this screen must communicate: pressing Call rings the STAFF
 * member's own phone first, and only bridges to the customer once they answer.
 * Africa's Talking places both legs, so nothing appears to happen on screen —
 * without saying so, the feature reads as broken.
 */

const STATUS_STYLE: Record<CallStatus, string> = {
  initiating: 'bg-muted text-muted-foreground border-border',
  queued: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  ringing_staff: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  bridged: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  completed: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  no_answer: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  failed: 'bg-destructive/10 text-destructive border-destructive/30',
};

/** Personas the call centre reaches. Values are real `app_role`s. */
const CALLABLE_ROLES = [
  { value: 'any', label: 'Anyone' },
  { value: 'tenant', label: 'Tenants' },
  { value: 'landlord', label: 'Landlords' },
  { value: 'supporter', label: 'Supporters' },
  { value: 'agent', label: 'Agents' },
] as const;

const fmtPhone = (bare: string | null) => (bare ? `+${bare.replace(/\D/g, '')}` : '—');

const fmtDuration = (seconds: number | null) => {
  if (!seconds || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

export function CallCentrePanel() {
  const [roleFilter, setRoleFilter] = useState<string>('any');
  const [picked, setPicked] = useState<UserResult | null>(null);
  const [manualPhone, setManualPhone] = useState('');
  const [staffPhone, setStaffPhone] = useState('');
  const [mineOnly, setMineOnly] = useState(true);
  const [statusFilter, setStatusFilter] = useState<CallStatus | 'all'>('all');
  const [annotating, setAnnotating] = useState<CallSession | null>(null);

  const placeCall = usePlaceCall();
  const annotate = useAnnotateCall();
  const { data: activity } = useMyCallActivityToday();
  const { data: sessions = [], isLoading } = useCallSessions({
    mineOnly,
    status: statusFilter,
    limit: 100,
  });

  const canCall = !!picked || manualPhone.trim().length > 0;

  const onCall = () => {
    placeCall.mutate(
      {
        targetUserId: picked?.id ?? null,
        targetPhone: picked ? null : manualPhone,
        targetName: picked?.full_name ?? null,
        targetRole: roleFilter === 'any' ? null : roleFilter,
        staffPhone: staffPhone || null,
      },
      {
        onSuccess: () => {
          setPicked(null);
          setManualPhone('');
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-black text-foreground">Call Centre</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Call tenants, landlords, supporters and agents through the platform. Calls are placed
          by Africa&apos;s Talking, logged automatically, and show the Welile number to the customer.
        </p>
      </div>

      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="flex items-start gap-3 py-4">
          <Info className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">Your phone rings first.</span>{' '}
            When you press Call, Africa&apos;s Talking rings your own handset. Answer it, and the
            call is then connected to the customer — so keep your phone with you.
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard icon={PhoneOutgoing} label="Calls today" value={activity?.calls_placed ?? 0} />
        <StatCard icon={CheckCircle2} label="Connected" value={activity?.calls_connected ?? 0} />
        <StatCard icon={Clock} label="Talk time" value={fmtDuration(activity?.total_seconds ?? 0)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <PhoneCall className="h-4 w-4" /> Place a call
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Who are you calling?</Label>
              <Select
                value={roleFilter}
                onValueChange={(v) => { setRoleFilter(v); setPicked(null); }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CALLABLE_ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>
                Ring me on <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                value={staffPhone}
                onChange={(e) => setStaffPhone(e.target.value)}
                placeholder="Defaults to your profile number"
              />
            </div>
          </div>

          <UserSearchPicker
            label="Find the person"
            placeholder="Search by name or phone..."
            selectedUser={picked}
            onSelect={(u) => { setPicked(u); if (u) setManualPhone(''); }}
            roleFilter={roleFilter === 'any' ? undefined : roleFilter}
          />

          {!picked && (
            <div className="space-y-2">
              <Label>
                Or dial a number directly
              </Label>
              <Input
                value={manualPhone}
                onChange={(e) => setManualPhone(e.target.value)}
                placeholder="07XX XXX XXX"
                inputMode="tel"
              />
            </div>
          )}

          <Button
            onClick={onCall}
            disabled={!canCall || placeCall.isPending}
            className="w-full sm:w-auto"
          >
            {placeCall.isPending
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Connecting…</>
              : <><PhoneCall className="h-4 w-4 mr-2" /> Call{picked ? ` ${picked.full_name}` : ''}</>}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-base">Call log</CardTitle>
          <div className="flex items-center gap-2">
            <Select value={mineOnly ? 'mine' : 'all'} onValueChange={(v) => setMineOnly(v === 'mine')}>
              <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mine">My calls</SelectItem>
                <SelectItem value="all">Everyone&apos;s calls</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as CallStatus | 'all')}>
              <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {(Object.keys(CALL_STATUS_LABEL) as CallStatus[]).map((s) => (
                  <SelectItem key={s} value={s}>{CALL_STATUS_LABEL[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No calls yet. Place one above and it will appear here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Called</TableHead>
                    <TableHead>Number</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {format(new Date(s.created_at), 'dd MMM HH:mm')}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium text-sm">{s.target_name || 'Unknown'}</div>
                        {s.target_role && (
                          <div className="text-xs text-muted-foreground capitalize">{s.target_role}</div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{fmtPhone(s.target_phone)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn('text-xs', STATUS_STYLE[s.status])}>
                          {s.status === 'no_answer' && <PhoneMissed className="h-3 w-3 mr-1" />}
                          {CALL_STATUS_LABEL[s.status]}
                        </Badge>
                        {s.failure_reason && (
                          <div className="text-[11px] text-muted-foreground mt-0.5">{s.failure_reason}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{fmtDuration(s.duration_seconds)}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7"
                          onClick={() => setAnnotating(s)}
                        >
                          {s.notes || s.disposition ? 'Edit' : 'Add'}
                        </Button>
                        {s.disposition && (
                          <div className="text-[11px] text-muted-foreground">{s.disposition}</div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AnnotateDialog
        session={annotating}
        onClose={() => setAnnotating(null)}
        onSave={(disposition, notes) => {
          if (!annotating) return;
          annotate.mutate(
            { sessionId: annotating.id, disposition, notes },
            { onSuccess: () => setAnnotating(null) },
          );
        }}
        saving={annotate.isPending}
      />
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: typeof PhoneCall; label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-4">
        <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <div>
          <div className="text-lg font-black leading-none">{value}</div>
          <div className="text-xs text-muted-foreground mt-1">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function AnnotateDialog({
  session, onClose, onSave, saving,
}: {
  session: CallSession | null;
  onClose: () => void;
  onSave: (disposition: string, notes: string) => void;
  saving: boolean;
}) {
  const [disposition, setDisposition] = useState('');
  const [notes, setNotes] = useState('');

  const sessionId = session?.id ?? null;
  const savedDisposition = session?.disposition ?? '';
  const savedNotes = session?.notes ?? '';

  // Re-seed the fields whenever a different call is opened, so the dialog never
  // shows the previous row's notes.
  useEffect(() => {
    if (!sessionId) return;
    setDisposition(savedDisposition);
    setNotes(savedNotes);
  }, [sessionId, savedDisposition, savedNotes]);

  return (
    <Dialog open={!!session} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Call notes{session?.target_name ? ` — ${session.target_name}` : ''}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Outcome</Label>
            <Input
              value={disposition}
              onChange={(e) => setDisposition(e.target.value)}
              placeholder="e.g. Promised to pay Friday"
            />
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="What was discussed?"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            For tenants and landlords, keep using the Calling Hub to record the call outcome that
            drives follow-ups. These notes cover the call itself.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => onSave(disposition, notes)} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
