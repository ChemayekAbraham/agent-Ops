/**
 * Utility to share a receipt summary via WhatsApp.
 */

const WHATSAPP_SUPPORT = '+256708257899';

interface ReceiptShareData {
  type: 'sent' | 'received' | 'payment' | 'collection';
  amount: number;
  currency?: string;
  recipientOrSender?: string;
  reference?: string;
  date: string;
  description?: string;
  method?: string;
  status?: string;
  agentName?: string;
  tenantPhone?: string;
  merchantName?: string;
  transactionId?: string;
}

export function buildReceiptText(data: ReceiptShareData): string {
  const currency = data.currency || 'UGX';
  const formatted = new Intl.NumberFormat('en-UG', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
  }).format(data.amount);

  const lines: string[] = [
    `📄 *Welile Receipt*`,
    `━━━━━━━━━━━━━━━━`,
  ];

  if (data.type === 'collection') {
    lines.push(`💰 *Amount:* ${formatted}`);
    if (data.agentName) lines.push(`👤 *Agent:* ${data.agentName}`);
    if (data.tenantPhone) lines.push(`📱 *Tenant Phone:* ${data.tenantPhone}`);
    if (data.merchantName) lines.push(`🏪 *Merchant:* ${data.merchantName}`);
    if (data.transactionId) lines.push(`🔗 *Txn ID:* ${data.transactionId}`);
  } else {
    const label = data.type === 'sent' ? 'Sent' : data.type === 'received' ? 'Received' : 'Payment';
    lines.push(`💰 *${label}:* ${formatted}`);
    if (data.recipientOrSender) {
      const roleLabel = data.type === 'sent' ? 'To' : data.type === 'received' ? 'From' : 'Recipient';
      lines.push(`👤 *${roleLabel}:* ${data.recipientOrSender}`);
    }
    if (data.method) lines.push(`💳 *Method:* ${data.method}`);
    if (data.status) lines.push(`✅ *Status:* ${data.status}`);
    if (data.reference) lines.push(`🔗 *Ref:* ${data.reference}`);
  }

  if (data.description) lines.push(`📝 *Note:* ${data.description}`);
  lines.push(`📅 *Date:* ${data.date}`);
  lines.push(`━━━━━━━━━━━━━━━━`);
  lines.push(`Powered by Welile`);

  return lines.join('\n');
}

export function shareViaWhatsApp(text: string, phoneNumber?: string) {
  const encoded = encodeURIComponent(text);
  const url = phoneNumber
    ? `https://wa.me/${phoneNumber.replace(/[^0-9]/g, '')}?text=${encoded}`
    : `https://wa.me/?text=${encoded}`;
  window.open(url, '_blank');
}
