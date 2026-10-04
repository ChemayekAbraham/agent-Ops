import { useMemo, useState, useCallback, useEffect } from 'react';
import { MonitorSmartphone, Smartphone, Laptop, LogOut, CheckCircle2, Pencil, Check, X } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { useDeviceSessions, type DeviceSession } from '@/hooks/useDeviceSessions';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function DeviceRow({
  session,
  onSignOut,
  onRename,
}: {
  session: DeviceSession;
  onSignOut: (deviceId: string) => void;
  onRename: (deviceId: string, label: string) => void;
}) {
  const isPhone = /Android|iPhone|iPad/i.test(session.device_label ?? '');
  const Icon = isPhone ? Smartphone : Laptop;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.device_label ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError("Device name can't be empty");
      return;
    }
    if (trimmed.length > 40) {
      setError('Device name must be 40 characters or less');
      return;
    }
    if (trimmed !== session.device_label) onRename(session.device_id, trimmed);
    setError(null);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(session.device_label ?? '');
    setError(null);
    setEditing(false);
  };

  useEffect(() => {
    if (!editing) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed.length > 40 || trimmed === session.device_label) return;
    const id = window.setTimeout(() => {
      onRename(session.device_id, trimmed);
      setEditing(false);
    }, 700);
    return () => window.clearTimeout(id);
  }, [draft, editing, session.device_id, session.device_label, onRename]);

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-card px-3 py-2.5">
      <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', session.isActive ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground')}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-col gap-1">
            <Input
              autoFocus
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') cancel();
              }}
              maxLength={40}
              placeholder="e.g. My Phone"
              aria-label="Device name"
              aria-invalid={!!error}
              className="h-8 text-sm"
            />
            {error && <p className="text-xs text-destructive leading-none">{error}</p>}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <p className="truncate text-sm font-medium text-foreground">
                {session.device_label || 'Unknown device'}
              </p>
              {session.isCurrent && (
                <Badge variant="primary" size="sm" className="shrink-0">This device</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {session.isActive ? 'Active' : 'Last seen'} · {timeAgo(session.last_seen_at)}
            </p>
          </>
        )}
      </div>
      {editing ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-success" aria-label="Save device name" onClick={save}>
            <Check className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground" aria-label="Cancel renaming" onClick={cancel}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            aria-label="Rename device"
            onClick={() => {
              setDraft(session.device_label ?? '');
              setEditing(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {!session.isCurrent && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
              aria-label="Sign out this device"
              onClick={() => onSignOut(session.device_id)}
            >
              <LogOut className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default function DeviceSessionsSection() {
  const { user } = useAuth();
  const { sessions, activeCount, isMultiDevice, loading, signOutDevice, renameDevice } = useDeviceSessions(user?.id);
  const [announce, setAnnounce] = useState('');

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent)),
    [sessions],
  );

  const handleRename = useCallback(
    (deviceId: string, label: string) => {
      renameDevice(deviceId, label);
      setAnnounce(`Device renamed to ${label}`);
      window.setTimeout(() => setAnnounce(''), 1000);
    },
    [renameDevice],
  );

  return (
    <Card className="border-border/40 rounded-2xl">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="h-4 w-4 text-primary" />
          <div>
            <CardTitle className="text-sm">Signed-in devices</CardTitle>
            <CardDescription className="text-xs">
              See everywhere your account is logged in and sign out any you don't recognise.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div aria-live="polite" aria-atomic="true" className="sr-only">{announce}</div>
        {loading && sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">Checking your devices…</p>
        ) : (
          <>
            {isMultiDevice ? (
              <div className="mb-3 flex items-start gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs text-warning">
                <MonitorSmartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Your account is signed in on <strong>{activeCount} devices</strong> right now.</span>
              </div>
            ) : (
              <div className="mb-3 flex items-start gap-2 rounded-lg bg-success/10 px-2.5 py-2 text-xs text-success">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Only this device is active.</span>
              </div>
            )}
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {sortedSessions.map((s) => (
                <DeviceRow key={s.id} session={s} onSignOut={signOutDevice} onRename={handleRename} />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}