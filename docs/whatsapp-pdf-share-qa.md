# WhatsApp PDF Share — Tap-Through QA Checklist

Verify each downloadable PDF opens WhatsApp with the **correct file attached** and the
**correct caption**. Run on a real phone (native share sheets can't be triggered in the sandbox).

Forms to test:
- **Landlord Registration Form**
- **Tenant Registration Form**

Open path: Agent Dashboard → top-right menu → **Downloadable PDFs**.

---

## Android (Chrome) — per form

- [ ] Tap the form's **Share on WhatsApp** action.
- [ ] WhatsApp opens with a **contact/chat picker** (native share sheet).
- [ ] Pick a chat → the **PDF appears attached** in the message composer.
- [ ] File name is correct (e.g. `landlord-registration-form.pdf` / `tenant-registration-form.pdf`).
- [ ] The **caption text** is pre-filled and reads correctly.
- [ ] Open the sent PDF in WhatsApp → it renders the right branded form (no blank/corrupt pages).
- [ ] Tapping **Cancel/back** on the share sheet returns to the dashboard with no error toast.

## iOS (Safari) — per form

- [ ] Tap the form's **Share on WhatsApp** action.
- [ ] The **iOS share sheet** appears → **WhatsApp** is listed as a target.
- [ ] Choose WhatsApp → pick a chat → the **PDF appears attached**.
- [ ] File name is correct for the selected form.
- [ ] The **caption text** is pre-filled and reads correctly.
- [ ] Open the sent PDF in WhatsApp → it renders the right branded form.
- [ ] Dismissing the share sheet returns to the dashboard with no error toast.

---

## Fallback (attachment unsupported)

Trigger when `navigator.share` with files isn't supported (older browser / desktop-on-phone mode).

- [ ] Tapping the action **downloads the PDF** to the device.
- [ ] A toast shows: **"Form downloaded — attach it in WhatsApp"**.
- [ ] WhatsApp opens via deep link (`whatsapp://send?...` on mobile, `wa.me` on desktop).
- [ ] The **caption** is present in the WhatsApp text field.
- [ ] The downloaded PDF can be manually attached and opens correctly.

---

## Sign-off

| Form | Android attach + caption | iOS attach + caption | Fallback |
|------|--------------------------|----------------------|----------|
| Landlord Registration | ☐ | ☐ | ☐ |
| Tenant Registration   | ☐ | ☐ | ☐ |

Tester: ______________   Device(s): ______________   Date: ____________