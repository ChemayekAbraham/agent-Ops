import { useEffect, type RefObject } from 'react';
import './landlordOpsMobile.css';

/** Staff money on Landlord Ops: always UGX, grouped with thousands separators. */
export function formatOpsUgx(amount: number | null | undefined): string {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n)) return 'UGX 0';
  const rounded = Math.round(n);
  const sign = rounded < 0 ? '-' : '';
  return `UGX ${sign}${Math.abs(rounded).toLocaleString('en-US')}`;
}

/** Copy each column heading onto its body cells so phone CSS can stack the row. */
export function stampLandlordOpsTables(root: ParentNode) {
  root.querySelectorAll('table').forEach((table) => {
    if (table.closest('.recharts-wrapper')) return;
    const headerRow = table.querySelector('thead tr:last-child');
    if (!headerRow) return;
    const headers = Array.from(headerRow.children).map((cell) =>
      (cell.textContent || '').replace(/\s+/g, ' ').trim(),
    );
    if (headers.every((label) => label.length === 0)) return;
    table.classList.add('lo-card-table');
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const cells = Array.from(tr.children).filter(
        (el): el is HTMLTableCellElement => el instanceof HTMLTableCellElement && el.tagName === 'TD',
      );
      if (cells.length === 1 && cells[0].colSpan > 1) {
        cells[0].setAttribute('data-label', '');
        return;
      }
      cells.forEach((td, index) => {
        const label = headers[index] ?? '';
        if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
      });
    });
  });
}

/** Marks the console so portaled dialogs can go full screen, and stacks its tables on a phone. */
export function useLandlordOpsMobile(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    document.documentElement.setAttribute('data-landlord-ops', '');
    let frame = 0;
    const run = () => {
      frame = 0;
      stampLandlordOpsTables(root);
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(run);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      document.documentElement.removeAttribute('data-landlord-ops');
    };
  }, [ref]);
}
