---
name: Google Drive document vault backup
description: Offsite Drive mirror of tenant IDs, contracts, receipts via drive-archive edge fn, filed by Year/Month/Type
type: feature
---
Offsite backup of documents into the company Google Drive (connector account weliletenants@gmail.com, scope `drive.file` — app sees only folders/files it created).

- Folder tree: `Welile Document Vault / <Year> / <NN Month> / {Tenant IDs | Contracts | Receipts | Other Documents}`.
- Edge fn `drive-archive` (operations: `init` pre-creates skeleton; `archive` mirrors one stored file). Auth via `admin.auth.getUser`, manual corsHeaders. Uses gateway `https://connector-gateway.lovable.dev/google_drive` with `LOVABLE_API_KEY` + `GOOGLE_DRIVE_API_KEY`. Multipart upload, find-or-create folders.
- Cloud storage stays PRIMARY; Drive is redundant archive only. Backup is fire-and-forget and must NEVER block/throw in the UI.
- Client helper `src/lib/archiveToDrive(bucket, path, docType)` (silent). Wired into: AgentRentRequestDialog tenant_passport→tenant_id (house-images); AgentDeliveryConfirmation→receipt (receipts); LandlordPayoutReceiptUpload→receipt (landlord-payout-receipts); DepositFlow bank slip→receipt (deposit-proofs); DocumentUploadPanel→contract (business-advance-documents).
- `drive_archive_log` table (UNIQUE source_bucket+source_path) makes archive idempotent; RLS: own rows + ops/manager read; writes via service role only. Emits system events `drive.document.archived` / `drive.vault.initialized`.
- Manager-only `DriveVaultCard` in Settings → Roles section: "Set up folder structure" (init) + open vault link + backup count.
