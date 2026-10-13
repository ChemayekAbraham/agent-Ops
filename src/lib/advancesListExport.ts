// Downloads the currently filtered advances list as PDF or Excel.
// Read-only: builds the file from rows already loaded on the page.

const fmt = (n: unknown) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const day = (d: unknown) => (d ? new Date(String(d)).toLocaleDateString('en-GB') : '');

function toRows(advances: any[]) {
  return advances.map((a) => ({
    Recipient: a.profiles?.full_name || 'Unknown',
    Phone: a.profiles?.phone || '',
    Principal: Number(a.principal) || 0,
    Interest: Math.max(0, Number(a.outstanding_balance) - Number(a.principal)),
    Outstanding: Number(a.outstanding_balance) || 0,
    'Access Fee': Number(a.access_fee) || 0,
    'Fee Collected': Number(a.access_fee_collected) || 0,
    'Fee Status': a.access_fee_status || '',
    Issued: day(a.issued_at),
    Expires: day(a.expires_at),
    Status: a.status || '',
  }));
}

const stamp = () => new Date().toISOString().slice(0, 10);

export async function downloadAdvancesExcel(advances: any[], filter: string) {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.json_to_sheet(toRows(advances));
  ws['!cols'] = [28, 16, 14, 14, 14, 14, 14, 12, 12, 12, 12].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Advances');
  const filename = `Welile_Advances_${filter}_${stamp()}.xlsx`;
  XLSX.writeFile(wb, filename);
  return filename;
}

export async function downloadAdvancesPdf(advances: any[], filter: string) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const rows = toRows(advances);
  doc.setFontSize(14);
  doc.text('Welile Advance Repayments', 14, 14);
  doc.setFontSize(9);
  doc.text(`Filter: ${filter}  |  Records: ${rows.length}  |  Generated: ${new Date().toLocaleString('en-GB')}`, 14, 20);
  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((s, r) => s + Number(r[k]), 0);
  autoTable(doc, {
    startY: 24,
    head: [['Recipient', 'Phone', 'Principal', 'Interest', 'Outstanding', 'Access Fee', 'Fee Collected', 'Fee Status', 'Issued', 'Expires', 'Status']],
    body: rows.map((r) => [r.Recipient, r.Phone, fmt(r.Principal), fmt(r.Interest), fmt(r.Outstanding), fmt(r['Access Fee']), fmt(r['Fee Collected']), r['Fee Status'], r.Issued, r.Expires, r.Status]),
    foot: [['Total', '', fmt(sum('Principal')), fmt(sum('Interest')), fmt(sum('Outstanding')), fmt(sum('Access Fee')), fmt(sum('Fee Collected')), '', '', '', '']],
    styles: { fontSize: 7 },
    headStyles: { fillColor: [124, 58, 237] },
    footStyles: { fillColor: [237, 233, 254], textColor: 20, fontStyle: 'bold' },
  });
  const filename = `Welile_Advances_${filter}_${stamp()}.pdf`;
  doc.save(filename);
  return filename;
}
