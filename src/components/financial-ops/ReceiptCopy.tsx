import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { WORDMARK_FONT, ensureChewy, type ReceiptCopyData } from '@/lib/receiptCopy';

/**
 * On-screen black-and-white receipt copy. Same layout as the paper receipt book and as the PDF built by buildReceiptCopyPdf.
 * Always pure black on white and grey, whatever the app theme: it is a document, not part of the interface.
 * Drawn at a fixed size and scaled to fit its container so the layout never reflows on a narrow screen.
 */
const BASE_W = 840;
const BASE_H = 592;
const INK = '#000';
const GREY = '#6e6e6e';

const dotted: CSSProperties = { flex: 1, borderBottom: `2px dotted ${INK}`, paddingLeft: 8, fontWeight: 700, minHeight: 26, lineHeight: '26px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' };

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 14, fontSize: 19 }}>
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
      <span style={dotted}>{children}</span>
    </div>
  );
}

export function ReceiptCopy({ data }: { data: ReceiptCopyData }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [qr, setQr] = useState<string | null>(null);
  const dead = data.status !== 'issued';

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setScale(Math.max(0.2, el.clientWidth / BASE_W));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The wordmark is set in Chewy. The copy shows in the fallback face until the font arrives.
  const [, setFontReady] = useState(false);
  useEffect(() => { void ensureChewy().then(setFontReady); }, []);

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(data.qrText, { margin: 0, width: 240, color: { dark: '#000000', light: '#ffffff' } })
      .then((u) => { if (live) setQr(u); })
      .catch(() => { if (live) setQr(null); });
    return () => { live = false; };
  }, [data.qrText]);

  return (
    <div ref={wrap} style={{ width: '100%', height: BASE_H * scale }} role="img" aria-label={`Receipt ${data.numberLabel} for UGX ${Math.round(data.amount).toLocaleString('en-US')}`}>
      <div style={{
        width: BASE_W, height: BASE_H, transform: `scale(${scale})`, transformOrigin: 'top left', position: 'relative', boxSizing: 'border-box',
        padding: '30px 42px', background: '#fff', color: INK, colorScheme: 'light', fontFamily: 'Helvetica, Arial, sans-serif', overflow: 'hidden',
        boxShadow: '0 1px 6px rgba(0,0,0,.25)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ fontFamily: WORDMARK_FONT, fontSize: 72, fontWeight: 400, letterSpacing: 0, lineHeight: 1 }}>Welile<sup style={{ fontFamily: 'Helvetica, Arial, sans-serif', fontSize: 12, fontWeight: 700, marginLeft: 2 }}>TM</sup></div>
          <div style={{ textAlign: 'right', fontSize: 13, lineHeight: '17px' }}>
            <div style={{ fontWeight: 700 }}>WELILE TECHNOLOGIES (U) LIMITED</div>
            <div>P.O Box 167564, Kampala - Uganda</div>
            <div>Email: info@welile.com</div>
            <div>Tel: +256 764 379 713, +256 744 475 573</div>
          </div>
        </div>
        <div style={{ borderBottom: `2px solid ${INK}`, marginTop: 10 }} />

        {/* No. / RECEIPT / Date */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
          <div style={{ fontSize: 19, minWidth: 220 }}>No: <b style={{ fontSize: 26 }}>{data.numberLabel}</b></div>
          <div style={{ border: `3px solid ${INK}`, padding: '4px 26px', fontSize: 28, fontWeight: 800, letterSpacing: 1 }}>RECEIPT</div>
          <div style={{ fontSize: 19, minWidth: 220, textAlign: 'right' }}>Date: <b>{data.dateLabel}</b></div>
        </div>

        {data.lines.map((l) => <Line key={l.label} label={l.label}>{l.value}</Line>)}

        {/* Amount, stamp, signatory */}
        <div style={{ position: 'absolute', left: 42, right: 42, top: 372, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ border: `3px solid ${INK}`, borderRadius: 14, padding: '8px 18px', fontSize: 30, fontWeight: 800, whiteSpace: 'nowrap' }}>
            Ugx. {Math.round(data.amount).toLocaleString('en-US')}/=
          </div>
          <div style={{ marginTop: -10, border: `2.5px solid ${GREY}`, borderRadius: 16, color: GREY, padding: '8px 18px', textAlign: 'center', transform: 'rotate(-4deg)', lineHeight: '17px' }}>
            <div style={{ fontWeight: 800, fontSize: 14 }}>WELILE TECHNOLOGIES<br />LIMITED</div>
            <div style={{ fontSize: 11 }}>P.O Box 167564 Kampala Uganda</div>
            <div style={{ fontWeight: 800, fontSize: 17, marginTop: 2 }}>{data.stampDate}</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 15 }}>
            <b>For Welile Technologies Limited.</b>
          </div>
        </div>
        <div style={{ position: 'absolute', left: 42, right: 42, top: 462, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <div style={{ width: 280 }}>
            <div style={{ borderTop: `2px dotted ${INK}`, paddingTop: 3 }}>{data.clientSignatureLabel}</div>
            {data.direction === 'in' && <div style={{ fontSize: 11 }}>(Cheques/Drafts are subject to rectification)</div>}
          </div>
          <div style={{ width: 290, textAlign: 'right' }}>
            <div style={{ borderTop: `2px dotted ${INK}`, paddingTop: 3 }}>{data.signatory ? `${data.signatory} ` : ''}(Authorised Signatory)</div>
          </div>
        </div>

        {/* Footer: reprint note, codes, QR */}
        <div style={{ position: 'absolute', left: 42, right: 42, bottom: 22, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 11.5, lineHeight: '15px' }}>
          <div>
            {data.replacesEarlier && !dead && <div>Replaces an earlier receipt.</div>}
            {data.reprintNote && <div style={{ fontWeight: 700 }}>{data.reprintNote}</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
            <div style={{ textAlign: 'right' }}>
              <div>Verify code: <b>{data.verifyCode}</b></div>
              <div>Digitally recorded copy. Internal payment acknowledgement, not a URA fiscal receipt.</div>
            </div>
            {qr ? <img src={qr} alt="" width={64} height={64} style={{ display: 'block', imageRendering: 'pixelated' }} /> : <div style={{ width: 64, height: 64, border: `1px solid ${GREY}` }} />}
          </div>
        </div>

        {/* VOID / CORRECTED: a voided receipt must never read as valid */}
        {dead && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ transform: 'rotate(-18deg)', fontSize: data.status === 'corrected' ? 120 : 170, fontWeight: 900, color: 'rgba(0,0,0,.16)', letterSpacing: 6, lineHeight: 1 }}>
              {data.status === 'corrected' ? 'CORRECTED' : 'VOID'}
            </div>
            <div style={{ marginTop: 40, fontSize: 18, fontWeight: 700 }}>
              {data.status === 'corrected' && data.replacedByNo != null ? `Replaced by No. ${data.replacedByNo}` : data.voidReason ?? ''}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ReceiptCopy;
