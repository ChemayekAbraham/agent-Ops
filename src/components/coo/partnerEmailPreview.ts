const LOGO_URL = 'https://welileapp.com/welile-logo.png';

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderPartnerEmailPreview(opts: {
  emailTitle: string;
  notificationType: string;
  partnerName: string;
  messageBodyHtml: string;
  notificationDate: string;
}): string {
  const {
    emailTitle, notificationType, partnerName,
    messageBodyHtml, notificationDate,
  } = opts;
  const unsubscribeUrl = '#preview-unsubscribe';
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(emailTitle)}</title>
  <style type="text/css">
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    table { border-collapse: collapse !important; }
    body { height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; }
    a { color: #7b19d4; text-decoration: none; font-weight: 600; }
    a:hover { color: #5a129e; text-decoration: underline; }
    .message-content p { margin: 0 0 15px 0; }
    .message-content p:last-child { margin: 0; }
    .message-content ul, .message-content ol { margin: 0 0 15px 0; padding-left: 20px; }
    .message-content li { margin-bottom: 5px; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f7f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f4f7f9;">
    <tr><td align="center" style="padding: 40px 10px;">
      <table width="600" border="0" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
        <tr><td height="6" style="background-color: #7b19d4; background-image: linear-gradient(90deg, #7b19d4 0%, #a855f7 100%);"></td></tr>
        <tr><td style="padding: 30px 40px; border-bottom: 1px solid #f1f5f9;">
          <table width="100%" border="0" cellpadding="0" cellspacing="0"><tr>
            <td align="left" valign="middle">
              <img src="${LOGO_URL}" alt="WELILE TECHNOLOGIES LTD" width="130" style="display: block; max-width: 130px; height: auto;" />
            </td>
            <td align="right" valign="middle" style="font-size: 11px; color: #94a3b8; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px;">
              ${escapeHtml(notificationType)}
            </td>
          </tr></table>
        </td></tr>
        <tr><td align="center" style="padding: 40px 40px 20px 40px;">
          <h1 style="margin: 0; color: #0f172a; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">${escapeHtml(emailTitle)}</h1>
        </td></tr>
        <tr><td align="left" style="padding: 0 40px 25px 40px;">
          <p style="margin: 0 0 15px 0; color: #0f172a; font-size: 16px; font-weight: 600;">Dear ${escapeHtml(partnerName)},</p>
          <div class="message-content" style="margin: 0; color: #475569; font-size: 15px; line-height: 24px;">
            ${messageBodyHtml}
          </div>
        </td></tr>
        <tr><td align="center" style="padding: 0 40px 30px 40px;">
          <table border="0" cellpadding="0" cellspacing="0"><tr>
            <td align="center" style="border-radius: 8px; background-color: #7b19d4;">
              <a href="tel:+256748747134" style="display: inline-block; padding: 14px 28px; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; border-radius: 8px; border: 1px solid #7b19d4;">
                <img src="https://img.icons8.com/ios-filled/50/ffffff/phone.png" alt="Call" width="18" style="vertical-align: middle; margin-right: 8px;" />
                <span style="vertical-align: middle;">+256 748 747 134</span>
              </a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="padding: 0 40px 40px 40px;">
          <p style="margin: 0 0 15px 0; color: #475569; font-size: 15px; line-height: 24px;"><strong>Date:</strong> ${escapeHtml(notificationDate)}</p>
          <p style="margin: 0; color: #475569; font-size: 15px; line-height: 24px;">Thank you for your continued trust and partnership with WELILE TECHNOLOGIES LTD.</p>
          <p style="margin: 25px 0 0 0; color: #0f172a; font-size: 15px; font-weight: 600;">Warm regards,<br /><span style="font-weight: 400; color: #475569;">WELILE TECHNOLOGIES LTD Team</span></p>
        </td></tr>
        <tr><td style="padding: 20px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
          <i><q style="margin: 0; color: #94a3b8; font-size: 12px; line-height: 18px; font-weight: 500;">Welile is turning rent into an asset.</q></i>
        </td></tr>
      </table>
      <table width="600" border="0" cellpadding="0" cellspacing="0" style="margin-top: 30px;">
        <tr><td align="center" style="padding: 0 20px;">
          <p style="margin: 0 0 12px 0; color: #94a3b8; font-size: 14px; font-weight: 700;">WELILE TECHNOLOGIES LTD</p>
          <p style="margin: 0 0 20px 0; font-size: 13px;"><a href="https://maps.app.goo.gl/zfmsP2m2cCXEJXPe9" style="color: #a855f7; text-decoration: none;">Palm Lane Kabaale, Entebbe</a></p>
          <p style="margin: 0 0 20px 0; color: #94a3b8; font-size: 12px; line-height: 18px;">You are receiving this email because you are a registered partner at Welile.<br />This is a communication notification. Please do not reply directly to this email.</p>
          <p style="margin: 0 0 15px 0;">
            <a href="${unsubscribeUrl}" style="color: #94a3b8; font-size: 12px; text-decoration: underline; margin: 0 10px;">Unsubscribe</a>
          </p>
          <p style="margin: 0; color: #cbd5e1; font-size: 12px;">&copy; 2026 Welile. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}