import { useEffect, useRef, useState } from 'react';
import type { Html5Qrcode as Html5QrcodeType } from 'html5-qrcode';
import { Loader2, ScanLine, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { parseStudentQr } from '@/lib/welileSchools';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called once with the student's profile id when a Welile Schools student QR code is read. */
  onStudent: (profileId: string) => void;
}

const READER_ID = 'welile-student-qr-reader';

/**
 * Full-screen camera that reads a student's Welile Schools QR code at the gate. Other QR codes
 * are ignored with a short note, and scanning carries on until a student code is read.
 */
export default function StudentQrScanner({ open, onClose, onStudent }: Props) {
  const scannerRef = useRef<Html5QrcodeType | null>(null);
  const doneRef = useRef(false);
  const [status, setStatus] = useState<'starting' | 'live' | 'error'>('starting');
  const [problem, setProblem] = useState<string | null>(null);
  const [notStudent, setNotStudent] = useState(false);
  // Latest callback, so a parent re-render never restarts the camera.
  const onStudentRef = useRef(onStudent);
  onStudentRef.current = onStudent;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    doneRef.current = false;
    setStatus('starting');
    setProblem(null);
    setNotStudent(false);

    const stop = async () => {
      const s = scannerRef.current;
      scannerRef.current = null;
      if (s?.isScanning) { try { await s.stop(); s.clear(); } catch { /* already stopped */ } }
    };

    (async () => {
      try {
        // ~330 KB: loaded only when the camera opens.
        const { Html5Qrcode } = await import('html5-qrcode');
        if (cancelled) return;
        const scanner = new Html5Qrcode(READER_ID, false);
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: (w, h) => { const side = Math.floor(Math.min(w, h) * 0.7); return { width: side, height: side }; } },
          (text) => {
            if (doneRef.current) return;
            const id = parseStudentQr(text);
            if (!id) { setNotStudent(true); return; }
            doneRef.current = true;
            try { navigator.vibrate?.(60); } catch { /* not supported */ }
            void stop();
            onStudentRef.current(id);
          },
          () => { /* no code in this frame yet */ },
        );
        if (cancelled) { void stop(); return; }
        setStatus('live');
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        const name = (err as { name?: string })?.name ?? String(err);
        setProblem(/NotAllowed|Permission/i.test(name)
          ? 'Camera permission was refused. Allow the camera for this site in the browser settings.'
          : 'The camera could not be opened on this phone.');
      }
    })();

    return () => { cancelled = true; void stop(); };
  }, [open]);

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Scan student QR code" className="fixed inset-0 z-[200] flex flex-col bg-black text-white">
      <div className="flex items-center justify-between px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-semibold"><ScanLine className="h-5 w-5" />Scan student QR code</p>
        <Button variant="ghost" size="icon" className="h-11 w-11 text-white hover:bg-white/10 hover:text-white" aria-label="Close scanner" onClick={onClose}>
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        <div id={READER_ID} className="w-full max-w-md [&_video]:!w-full [&_video]:object-cover" />
        {status === 'starting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2"><Loader2 className="h-8 w-8 animate-spin" /><p className="text-sm text-white/80">Starting camera…</p></div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <div className="space-y-3">
              <p className="font-semibold">Camera not available</p>
              <p className="text-sm text-white/75">{problem}</p>
              <Button variant="outline" className="border-white/40 bg-transparent text-white hover:bg-white/10 hover:text-white" onClick={onClose}>Close</Button>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 text-center">
        {notStudent
          ? <p className="text-sm font-medium text-amber-300">That is not a Welile Schools student code. Scan the code from the student's card.</p>
          : <p className="text-sm text-white/80">Hold the student's QR code inside the square.</p>}
      </div>
    </div>
  );
}
