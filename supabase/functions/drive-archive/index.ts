// drive-archive: mirrors documents (tenant IDs, contracts, receipts) from Cloud
// storage into the company Google Drive as an OFFSITE BACKUP, organized by date:
//   Welile Document Vault / <Year> / <Month> / <Tenant IDs | Contracts | Receipts>
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
const DRIVE_API_KEY = Deno.env.get("GOOGLE_DRIVE_API_KEY")!;

const GATEWAY = "https://connector-gateway.lovable.dev/google_drive";
const ROOT_FOLDER_NAME = "Welile Document Vault";
const MONTHS = [
  "01 January", "02 February", "03 March", "04 April", "05 May", "06 June",
  "07 July", "08 August", "09 September", "10 October", "11 November", "12 December",
];

const DOC_TYPE_FOLDERS: Record<string, string> = {
  tenant_id: "Tenant IDs",
  contract: "Contracts",
  receipt: "Receipts",
};

function driveHeaders(extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${LOVABLE_API_KEY}`,
    "X-Connection-Api-Key": DRIVE_API_KEY,
    ...extra,
  };
}

async function driveJson(path: string, init?: RequestInit) {
  const res = await fetch(`${GATEWAY}${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Drive API ${res.status} on ${path}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function ensureFolder(name: string, parentId: string | null): Promise<string> {
  const safeName = name.replace(/'/g, "\\'");
  const parentClause = parentId ? ` and '${parentId}' in parents` : "";
  const q = encodeURIComponent(
    `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`,
  );
  const found = await driveJson(`/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`, {
    headers: driveHeaders(),
  });
  if (found.files && found.files.length > 0) return found.files[0].id;

  const reqBody: Record<string, unknown> = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) reqBody.parents = [parentId];
  const created = await driveJson(`/drive/v3/files?fields=id`, {
    method: "POST",
    headers: driveHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(reqBody),
  });
  return created.id;
}

async function ensureRoot(): Promise<{ id: string; link: string }> {
  const id = await ensureFolder(ROOT_FOLDER_NAME, null);
  return { id, link: `https://drive.google.com/drive/folders/${id}` };
}

async function ensureDatedFolder(rootId: string, docType: string, when: Date) {
  const year = String(when.getUTCFullYear());
  const month = MONTHS[when.getUTCMonth()];
  const typeName = DOC_TYPE_FOLDERS[docType] ?? "Other Documents";
  const yearId = await ensureFolder(year, rootId);
  const monthId = await ensureFolder(month, yearId);
  const typeId = await ensureFolder(typeName, monthId);
  return {
    id: typeId,
    path: `${ROOT_FOLDER_NAME}/${year}/${month}/${typeName}`,
  };
}

function multipartBody(meta: object, bytes: Uint8Array, contentType: string, boundary: string) {
  const enc = new TextEncoder();
  const pre = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(meta)}\r\n--${boundary}\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const post = enc.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(pre.length + bytes.length + post.length);
  out.set(pre, 0);
  out.set(bytes, pre.length);
  out.set(post, pre.length + bytes.length);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Missing authorization" }, 401);
    const { data: u, error: uErr } = await admin.auth.getUser(auth.replace("Bearer ", ""));
    if (uErr || !u?.user) return json({ error: "Invalid token" }, 401);
    const userId = u.user.id;

    if (!LOVABLE_API_KEY || !DRIVE_API_KEY) {
      return json({ error: "Google Drive connection is not configured" }, 503);
    }

    const body = (await req.json().catch(() => ({}))) ?? {};
    const operation = body.operation ?? "archive";

    if (operation === "init") {
      const root = await ensureRoot();
      const now = new Date();
      for (const dt of Object.keys(DOC_TYPE_FOLDERS)) {
        await ensureDatedFolder(root.id, dt, now);
      }
      await logSystemEvent(admin, "drive.vault.initialized", userId, "drive_folder", root.id, {
        root_link: root.link,
      });
      return json({ ok: true, root_folder_id: root.id, root_link: root.link });
    }

    const { bucket, path, doc_type } = body as {
      bucket?: string;
      path?: string;
      doc_type?: string;
    };
    if (!bucket || typeof bucket !== "string") return json({ error: "bucket required" }, 400);
    if (!path || typeof path !== "string") return json({ error: "path required" }, 400);
    const docType = typeof doc_type === "string" ? doc_type : "receipt";

    const { data: existing } = await admin
      .from("drive_archive_log")
      .select("id, drive_file_id, drive_file_link, status")
      .eq("source_bucket", bucket)
      .eq("source_path", path)
      .maybeSingle();
    if (existing && existing.status === "success" && existing.drive_file_id) {
      return json({ ok: true, already_archived: true, drive_file_link: existing.drive_file_link });
    }

    const { data: blob, error: dlErr } = await admin.storage.from(bucket).download(path);
    if (dlErr || !blob) {
      const msg = dlErr?.message ?? "File not found in storage";
      await admin.from("drive_archive_log").upsert(
        { user_id: userId, doc_type: docType, source_bucket: bucket, source_path: path, status: "failed", error: msg },
        { onConflict: "source_bucket,source_path" },
      );
      return json({ error: msg }, 404);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const contentType = blob.type || "application/octet-stream";
    const fileName = path.split("/").pop() || `${docType}-${Date.now()}`;

    const root = await ensureRoot();
    const folder = await ensureDatedFolder(root.id, docType, new Date());

    const boundary = `welile-${crypto.randomUUID()}`;
    const meta = { name: fileName, parents: [folder.id] };
    const uploaded = await driveJson(
      `/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink`,
      {
        method: "POST",
        headers: driveHeaders({ "Content-Type": `multipart/related; boundary=${boundary}` }),
        body: multipartBody(meta, bytes, contentType, boundary),
      },
    );

    await admin.from("drive_archive_log").upsert(
      {
        user_id: userId,
        doc_type: docType,
        source_bucket: bucket,
        source_path: path,
        file_name: fileName,
        file_size: bytes.length,
        drive_file_id: uploaded.id,
        drive_file_link: uploaded.webViewLink,
        drive_folder_path: folder.path,
        status: "success",
        error: null,
      },
      { onConflict: "source_bucket,source_path" },
    );

    await logSystemEvent(admin, "drive.document.archived", userId, "drive_file", uploaded.id, {
      doc_type: docType,
      folder_path: folder.path,
      file_name: fileName,
    });

    return json({
      ok: true,
      drive_file_id: uploaded.id,
      drive_file_link: uploaded.webViewLink,
      folder_path: folder.path,
    });
  } catch (e) {
    console.error("[drive-archive] error", e);
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
