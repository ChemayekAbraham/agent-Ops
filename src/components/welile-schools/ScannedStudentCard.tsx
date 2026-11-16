import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, LogIn, LogOut, ScanLine, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatEatTime, studentCode, type SchoolProfileRow } from '@/lib/welileSchools';
import { studentPhotoUrl } from '@/lib/welileSchoolsPhoto';

interface Props {
  student: SchoolProfileRow;
  /** Where the student is now, from today's gate log. */
  now: { direction: 'in' | 'out'; recorded_at: string } | null;
  /** What the student has already used today: a student gets one entry and one exit a day. */
  used: { in: boolean; out: boolean };
  /** Records the movement; resolves once it is saved (or queued on the phone). */
  onRecord: (direction: 'in' | 'out') => Promise<void>;
  onScanNext: () => void;
  onDone: () => void;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex justify-between gap-3 py-2.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{value}</dd>
    </div>
  );
}

/**
 * A scanned student at the gate: their photo and details, and one button that records them in or
 * out. The button follows where they are now (inside → exit, otherwise → entry).
 */
/** The direction to offer: the opposite of where they are, unless that one is already used today. */
function pickDirection(now: Props['now'], used: Props['used']): 'in' | 'out' | null {
  const preferred: 'in' | 'out' = now?.direction === 'in' ? 'out' : 'in';
  if (!used[preferred]) return preferred;
  const other = preferred === 'in' ? 'out' : 'in';
  return used[other] ? null : other;
}

export default function ScannedStudentCard({ student, now, used, onRecord, onScanNext, onDone }: Props) {
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoState, setPhotoState] = useState<'loading' | 'shown' | 'none'>(student.photo_path ? 'loading' : 'none');
  const [saving, setSaving] = useState(false);
  const [recorded, setRecorded] = useState<'in' | 'out' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [direction, setDirection] = useState<'in' | 'out' | null>(() => pickDirection(now, used));
  const canSwitch = direction != null && !used[direction === 'in' ? 'out' : 'in'];

  useEffect(() => {
    let live = true;
    setPhoto(null);
    setRecorded(null);
    setFailure(null);
    setDirection(pickDirection(now, used));
    if (!student.photo_path) { setPhotoState('none'); return; }
    setPhotoState('loading');
    studentPhotoUrl(student.photo_path).then((url) => {
      if (!live) return;
      setPhoto(url);
      setPhotoState(url ? 'shown' : 'none');
    });
    return () => { live = false; };
    // A new student (or a new status) resets the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student.id]);

  const record = async () => {
    if (!direction) return;
    setSaving(true);
    setFailure(null);
    try {
      await onRecord(direction);
      setRecorded(direction);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const nowText = now?.direction === 'in' ? `Inside since ${formatEatTime(now.recorded_at)}`
    : now?.direction === 'out' ? `Left at ${formatEatTime(now.recorded_at)}` : 'Not recorded today';

  return (
    <section aria-label={`Scanned student ${student.full_name ?? ''}`} className="space-y-3 rounded-3xl border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted">
          {photoState === 'shown' && photo ? <img src={photo} alt={`Photo of ${student.full_name}`} className="h-full w-full object-cover" />
            : photoState === 'loading' ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading photo" />
            : <UserRound className="h-10 w-10 text-muted-foreground" aria-label="No photo" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">Student</p>
          <p className="text-lg font-bold leading-tight">{student.full_name || 'Unnamed student'}</p>
          <p className="font-mono text-xs text-muted-foreground">{studentCode(student.id)}</p>
          <p className={cn('mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
            now?.direction === 'in' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
              : now?.direction === 'out' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground')}>
            {nowText}
          </p>
        </div>
      </div>
      {photoState === 'none' && <p className="text-xs text-amber-700 dark:text-amber-400">No photo on record. Check the student's identity another way.</p>}

      <dl className="divide-y divide-border/60 rounded-2xl bg-muted/50 px-3">
        <Row label="Class" value={[student.class_grade, student.stream].filter(Boolean).join(' · ')} />
        <Row label="Day or boarding" value={student.boarding_status} />
        <Row label="Gender" value={student.gender} />
        <Row label="Age" value={student.age} />
        <Row label="Admission / ID no." value={student.id_number} />
        <Row label="Parent / guardian" value={student.guardian_name} />
        <Row label="Guardian phone" value={student.guardian_phone ? <a className="text-primary underline-offset-2 hover:underline" href={`tel:${student.guardian_phone}`}>{student.guardian_phone}</a> : null} />
        <Row label="Home village" value={student.residence_village} />
      </dl>

      {recorded ? (
        <div className="space-y-2">
          <p className="flex items-center gap-2 rounded-2xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300">
            <CheckCircle2 className="h-5 w-5 shrink-0" />{student.full_name} recorded {recorded === 'in' ? 'entering' : 'leaving'}.
          </p>
          <Button className="min-h-[52px] w-full gap-2 rounded-2xl text-base" onClick={onScanNext}><ScanLine className="h-5 w-5" />Scan the next student</Button>
          <Button variant="ghost" className="min-h-[44px] w-full" onClick={onDone}>Done</Button>
        </div>
      ) : direction == null ? (
        // Both used: one entry and one exit already recorded today.
        <div className="space-y-2">
          <p className="flex items-center gap-2 rounded-2xl bg-muted p-3 text-sm font-semibold">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-muted-foreground" />Done for today: {student.full_name} already has an entry and an exit recorded.
          </p>
          <Button className="min-h-[52px] w-full gap-2 rounded-2xl text-base" onClick={onScanNext}><ScanLine className="h-5 w-5" />Scan the next student</Button>
          <Button variant="ghost" className="min-h-[44px] w-full" onClick={onDone}>Done</Button>
        </div>
      ) : (
        <div className="space-y-2">
          {failure && <p role="alert" className="rounded-2xl bg-destructive/10 p-3 text-sm font-medium text-destructive">{failure}</p>}
          <Button disabled={saving} onClick={record}
            className={cn('min-h-[56px] w-full gap-2 rounded-2xl text-base',
              direction === 'in' ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}>
            {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : direction === 'in' ? <LogIn className="h-5 w-5" /> : <LogOut className="h-5 w-5" />}
            {direction === 'in' ? 'Record entry' : 'Record exit'}
          </Button>
          <div className="flex gap-2">
            {canSwitch ? (
              <Button variant="ghost" className="min-h-[44px] flex-1 text-muted-foreground" onClick={() => setDirection((d) => (d === 'in' ? 'out' : 'in'))}>
                {direction === 'in' ? 'Recording an exit instead?' : 'Recording an entry instead?'}
              </Button>
            ) : (
              <p className="flex min-h-[44px] flex-1 items-center px-2 text-xs text-muted-foreground">
                {direction === 'in' ? 'Exit already recorded today.' : 'Entry already recorded today.'}
              </p>
            )}
            <Button variant="ghost" className="min-h-[44px] text-muted-foreground" onClick={onDone}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}
