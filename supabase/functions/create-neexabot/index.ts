// One-off: creates the NeexaBot system referrer account (idempotent). Delete after use.
import { createClient } from "npm:@supabase/supabase-js@2";
Deno.serve(async () => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const email = "neexabot@welileapp.com";
  const { data: ex } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  if (ex) return new Response(JSON.stringify({ id: ex.id, existed: true }));
  const pw = crypto.randomUUID() + crypto.randomUUID();
  const { data, error } = await admin.auth.admin.createUser({
    email, password: pw, email_confirm: true,
    user_metadata: { full_name: "NeexaBot", name: "NeexaBot" },
  });
  return new Response(JSON.stringify({ id: data?.user?.id, error: error?.message }));
});
