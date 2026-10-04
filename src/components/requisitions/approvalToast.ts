/**
 * Shared presentation for the requisition approval confirmation popup.
 *
 * Every desk in the approval chain (department head, COO, CEO, CFO) shows the
 * same green success state, coloured from the shared `--success` design token
 * so the confirmation reads identically in light and dark mode and on every
 * dashboard.
 *
 * Presentation only — no decision routing, permissions, status or wallet logic
 * lives here.
 */
export const REQUISITION_APPROVED_MESSAGE = 'Requisition approved successfully.';

export const APPROVAL_TOAST_OPTIONS = {
  duration: 5000,
  style: {
    background:
      'linear-gradient(hsl(var(--success) / 0.14), hsl(var(--success) / 0.14)), hsl(var(--background))',
    borderColor: 'hsl(var(--success) / 0.45)',
    color: 'hsl(var(--success))',
    boxShadow: '0 10px 30px -12px hsl(var(--success) / 0.5)',
  },
};
