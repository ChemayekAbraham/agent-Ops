import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

const MAX_MESSAGE_CHARS = 500;
const MAX_COMMENT_CHARS = 1000;

/** Strip ASCII control chars (except \n and \t) and trim. */
export function cleanMessage(raw: string): string {
  // deno-lint-ignore no-control-regex
  return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
}

/**
 * Optional client-reported device context. Used only for audit metadata on the
 * conversation record — never passed to the model or used for authorization.
 */
const DeviceContextSchema = z
  .object({
    platform: z.string().max(40).optional(),
    language: z.string().max(20).optional(),
    timezone: z.string().max(60).optional(),
    screen_w: z.number().int().min(0).max(20000).optional(),
    screen_h: z.number().int().min(0).max(20000).optional(),
    pixel_ratio: z.number().min(0).max(20).optional(),
    touch: z.boolean().optional(),
  })
  .strict();

const GeoContextSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy_m: z.number().min(0).max(1_000_000).optional(),
  })
  .strict();

export const ClientContextSchema = z
  .object({
    device: DeviceContextSchema.optional(),
    geo: GeoContextSchema.optional(),
  })
  .strict();

export type ClientContext = z.infer<typeof ClientContextSchema>;

/**
 * Strict request schema. `.strict()` rejects any unknown property — in particular
 * `user_id`, `staff_id`, `role`, `roles`, `persona`, `system`, `tools`, or `history`
 * — so the client cannot inject identity, roles, or prompt instructions.
 */
export const RequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("access"),
    })
    .strict(),
  z
    .object({
      action: z.literal("message"),
      message: z
        .string()
        .transform(cleanMessage)
        .refine((s) => s.length >= 1 && s.length <= MAX_MESSAGE_CHARS, {
          message: `Message must be between 1 and ${MAX_MESSAGE_CHARS} characters.`,
        }),
      conversation_id: z.string().uuid().optional(),
      client_context: ClientContextSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("feedback"),
      conversation_id: z.string().uuid(),
      message_id: z.string().uuid(),
      rating: z.enum(["up", "down"]),
      comment: z
        .string()
        .transform(cleanMessage)
        .refine((s) => s.length <= MAX_COMMENT_CHARS, {
          message: `Comment must be at most ${MAX_COMMENT_CHARS} characters.`,
        })
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("history"),
      conversation_id: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("clear_history"),
      conversation_id: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("morning_brief"),
      force: z.boolean().optional(),
    })
    .strict(),
]);

export type RequestBody = z.infer<typeof RequestSchema>;
