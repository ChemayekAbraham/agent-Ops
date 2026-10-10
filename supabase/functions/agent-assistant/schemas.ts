import { z } from "https://esm.sh/zod@3.23.8";

// Control characters (except \n and \t) never belong in a chat message.
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanMessage(raw: string): string {
  return raw.normalize("NFKC").replace(CONTROL_CHARS, "").trim();
}

const messageText = z.string().transform(cleanMessage).pipe(z.string().min(1).max(500));

const shortText = (max: number) =>
  z.string().transform((s) => s.replace(CONTROL_CHARS, "").trim()).pipe(z.string().max(max));

/**
 * Context the client may report about itself. All of it is untrusted and stored only as a hint
 * for the CRM: strict keys, hard numeric bounds, short strings. GPS is optional and only ever
 * present if the agent granted permission in the browser/app.
 */
export const ClientContextSchema = z.object({
  device: z.object({
    platform: shortText(40).optional(),
    language: shortText(20).optional(),
    timezone: shortText(60).optional(),
    screen_w: z.number().int().min(0).max(20000).optional(),
    screen_h: z.number().int().min(0).max(20000).optional(),
    pixel_ratio: z.number().min(0).max(10).optional(),
    touch: z.boolean().optional(),
  }).strict().optional(),
  geo: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy_m: z.number().min(0).max(100000).optional(),
  }).strict().optional(),
}).strict();

export type ClientContext = z.infer<typeof ClientContextSchema>;

/**
 * The ONLY shape the client may send. `.strict()` rejects unknown keys, so a tampered request
 * carrying `user_id`, `role`, `persona`, `system` or `history` fails validation outright.
 * Identity comes from the verified JWT; history comes from our own table.
 */
export const RequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("message"),
    message: messageText,
    conversation_id: z.string().uuid().optional(),
    client_context: ClientContextSchema.optional(),
  }).strict(),
  z.object({
    action: z.literal("escalate"),
    conversation_id: z.string().uuid(),
    note: z.string().transform(cleanMessage).pipe(z.string().max(1000)).optional(),
  }).strict(),
]);

export type AssistantRequest = z.infer<typeof RequestSchema>;
