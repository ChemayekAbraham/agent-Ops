import { useRef } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { CheckCircle2, CloudOff, Download, User, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { studentCode, studentQrValue, type SchoolProfileRow, type SchoolRow } from '@/lib/welileSchools';

function Row({ label, value }: { label: string; value?: string | number | null }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-medium">{value}</span>
    </div>
  );
}

/**
 * Shown right after a student is registered: their details, face photo and a QR
 * code that uniquely identifies them (it holds only their profile id).
 */
export default function StudentProfileSummary({ row, saved, photoUrl, school, onNext }: {
  row: SchoolProfileRow;
  saved: boolean;
  photoUrl: string | null;
  school: Pick<SchoolRow, 'name'>;
  onNext: () => void;
}) {
  const qrWrap = useRef<HTMLDivElement>(null);
  const code = studentCode(row.id);

  const downloadQr = () => {
    const canvas = qrWrap.current?.querySelector('canvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `${(row.full_name || 'student').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${code}.png`;
    a.click();
  };

  const age = row.age ?? null;
  return (
    <div className="space-y-4">
      <div role="status" aria-live="polite" className={cn('flex gap-3 rounded-2xl border p-4', saved ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30' : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30')}>
        {saved ? <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <CloudOff className="h-6 w-6 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />}
        <div className="min-w-0">
          <p className="font-semibold">{saved ? 'Registration successful' : 'Saved on this phone'}</p>
          <p className="text-sm text-muted-foreground">{saved ? `${row.full_name} is registered at ${school.name}.` : 'It uploads automatically when you are back online. The QR code works already.'}</p>
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-4 bg-primary/5 p-4">
          {photoUrl ? (
            <img src={photoUrl} alt={`Photo of ${row.full_name ?? 'the student'}`} className="h-24 w-24 shrink-0 rounded-2xl object-cover ring-2 ring-background" />
          ) : (
            <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-2xl bg-muted" aria-label="No photo"><User className="h-10 w-10 text-muted-foreground" /></div>
          )}
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">Student</p>
            <h2 className="break-words text-xl font-bold leading-tight">{row.full_name}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{[row.class_grade, row.stream].filter(Boolean).join(' · ') || school.name}</p>
            <p className="mt-1 font-mono text-sm font-semibold tracking-wider">{code}</p>
          </div>
        </div>

        <div className="divide-y divide-border px-4">
          <Row label="School" value={school.name} />
          <Row label="Class" value={row.class_grade} />
          <Row label="Stream / dormitory" value={row.stream} />
          <Row label="Day or boarding" value={row.boarding_status} />
          <Row label="Gender" value={row.gender} />
          <Row label="Date of birth" value={row.date_of_birth} />
          <Row label="Age" value={age} />
          <Row label="ID / admission no." value={row.id_number} />
          <Row label="Parent / guardian" value={row.guardian_name} />
          <Row label="Guardian phone" value={row.guardian_phone} />
          <Row label="Guardian WhatsApp" value={row.guardian_whatsapp} />
        </div>
      </Card>

      <Card className="flex flex-col items-center gap-3 p-5 text-center">
        <p className="text-sm font-semibold">Student QR code</p>
        <div ref={qrWrap} className="rounded-2xl bg-white p-3">
          <QRCodeCanvas value={studentQrValue(row.id)} size={208} level="M" includeMargin={false} aria-label={`QR code for ${row.full_name}, ${code}`} />
        </div>
        <p className="font-mono text-base font-bold tracking-widest">{code}</p>
        <p className="max-w-xs text-xs text-muted-foreground">Unique to this student. Scan it at the gate or quote the code. It holds no personal details.</p>
        <Button variant="outline" className="min-h-[44px] gap-2" onClick={downloadQr}><Download className="h-4 w-4" />Save QR code</Button>
      </Card>

      <Button className="min-h-[52px] w-full gap-2 text-base" onClick={onNext}><UserPlus className="h-5 w-5" />Register the next student</Button>
    </div>
  );
}
