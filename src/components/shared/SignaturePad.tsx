import { useRef, useEffect, useState, useCallback } from 'react';
import { Eraser, PenLine } from 'lucide-react';

interface SignaturePadProps {
  /** Called with a PNG data URL whenever the signature changes; empty string when cleared. */
  onChange: (dataUrl: string) => void;
  /** Accessible label / heading shown above the pad. */
  label?: string;
  className?: string;
}

/**
 * Lightweight hand-drawn signature pad. Works with mouse + touch, is fully
 * responsive (canvas backing store is sized to the rendered box via devicePixelRatio),
 * and exposes a Clear button so the signer can redo. Emits a transparent PNG
 * data URL so it drops straight into the partner agreement in place of the
 * italic typed name.
 */
export function SignaturePad({ onChange, label = 'Sign here', className = '' }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const hasInk = useRef(false);
  // Keep the most recent captured signature so a resize (mobile keyboard show/
  // hide, address-bar collapse, layout shift on submit) never wipes what the
  // user already drew. Re-rendering the backing store on resize used to clear
  // the pad and emit onChange('') — which dropped the signature from the
  // contract and fell back to the italic typed name.
  const lastDataUrl = useRef<string>('');
  const [isEmpty, setIsEmpty] = useState(true);

  const getCtx = () => canvasRef.current?.getContext('2d') ?? null;

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1e1b4b';
  }, []);

  useEffect(() => {
    setupCanvas();
    const onResize = () => {
      // Re-size the backing store, then restore the previously drawn signature
      // (if any) so it is preserved across resizes. Never clear the captured
      // value here — that would silently drop the signature from the contract.
      setupCanvas();
      const prev = lastDataUrl.current;
      if (prev) {
        const img = new Image();
        img.onload = () => {
          const ctx = getCtx();
          const canvas = canvasRef.current;
          if (!ctx || !canvas) return;
          const rect = canvas.getBoundingClientRect();
          ctx.drawImage(img, 0, 0, rect.width, rect.height);
        };
        img.src = prev;
        hasInk.current = true;
        setIsEmpty(false);
      } else {
        hasInk.current = false;
        setIsEmpty(true);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupCanvas]);

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pointFromEvent(e);
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = getCtx();
    if (!ctx || !last.current) return;
    const p = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!hasInk.current) {
      hasInk.current = true;
      setIsEmpty(false);
    }
  };

  const end = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    if (hasInk.current) {
      const url = canvasRef.current!.toDataURL('image/png');
      lastDataUrl.current = url;
      onChange(url);
    }
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = getCtx();
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
    lastDataUrl.current = '';
    setIsEmpty(true);
    onChange('');
  };

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-semibold text-gray-500 flex items-center gap-1">
          <PenLine size={13} className="text-[#6c11d4]" /> {label}
        </span>
        <button
          type="button"
          onClick={clear}
          disabled={isEmpty}
          className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-red-500 disabled:opacity-40 disabled:hover:text-gray-400 transition-colors"
        >
          <Eraser size={12} /> Clear
        </button>
      </div>
      <div className="relative rounded-xl border-2 border-dashed border-gray-300 bg-gray-50/80 overflow-hidden">
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          onPointerCancel={end}
          className="w-full h-32 block touch-none cursor-crosshair"
          style={{ touchAction: 'none' }}
        />
        {isEmpty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-xs text-gray-300 select-none">Draw your signature here</span>
          </div>
        )}
        <div className="pointer-events-none absolute bottom-3 left-4 right-4 border-b border-gray-300" />
      </div>
    </div>
  );
}

export default SignaturePad;
