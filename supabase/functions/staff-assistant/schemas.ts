import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

export const MAX_MESSAGE_CHARS = 2000;
const MAX_COMMENT_CHARS = 1000;
const MAX_TITLE_CHARS = 120;

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

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export const AttachmentInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    mime_type: z.string().trim().min(1).max(120),
    size_bytes: z.number().int().min(1).max(MAX_ATTACHMENT_SIZE_BYTES),
    kind: z.enum(["pdf", "word", "spreadsheet", "image", "text"]),
    extracted_text: z.string().max(40000).optional(),
    image_data_url: z.string().max(4_000_000).optional(),
    pii_warning: z.string().max(400).optional(),
    storage_path: z.string().max(400).optional(),
  })
  .strict();

export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;

export const PageContextSchema = z
  .object({
    route: z.string().trim().min(1).max(160),
    title: z.string().trim().max(120).optional(),
    filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    period: z.string().trim().max(80).optional(),
  })
  .strict();

export type PageContextInput = z.infer<typeof PageContextSchema>;

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
      page_context: PageContextSchema.optional(),
      project_id: z.string().uuid().optional(),
      attachments: z.array(AttachmentInputSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
      stream: z.boolean().optional(),
      regenerate: z.boolean().optional(),
      research_mode: z.boolean().optional(),
      temporary_chat: z.boolean().optional(),
      memory_enabled: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("feedback"),
      conversation_id: z.string().uuid(),
      message_id: z.string().uuid(),
      rating: z.enum(["up", "down"]),
      report_kind: z.enum(["rating", "problem_report"]).optional(),
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
      action: z.literal("conversations"),
      limit: z.number().int().min(1).max(40).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("new_conversation"),
      title: z
        .string()
        .transform(cleanMessage)
        .refine((s) => s.length >= 1 && s.length <= MAX_TITLE_CHARS, {
          message: `Title must be between 1 and ${MAX_TITLE_CHARS} characters.`,
        })
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("rename_conversation"),
      conversation_id: z.string().uuid(),
      title: z
        .string()
        .transform(cleanMessage)
        .refine((s) => s.length >= 1 && s.length <= MAX_TITLE_CHARS, {
          message: `Title must be between 1 and ${MAX_TITLE_CHARS} characters.`,
        }),
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
  z
    .object({
      action: z.literal("list_notes"),
    })
    .strict(),
  z
    .object({
      action: z.literal("add_note"),
      note_text: z.string().trim().min(2).max(240),
    })
    .strict(),
  z
    .object({
      action: z.literal("delete_note"),
      note_id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("update_note"),
      note_id: z.string().uuid(),
      note_text: z.string().trim().min(2).max(240),
    })
    .strict(),
  z
    .object({
      action: z.literal("get_memory_prefs"),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_memory_prefs"),
      memory_enabled: z.boolean().optional(),
      dismiss_preference_key: z.string().trim().max(80).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("personalised_starters"),
    })
    .strict(),
  z
    .object({
      action: z.literal("list_glossary"),
      search: z.string().trim().max(80).optional(),
      category: z.string().trim().max(40).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("search_knowledge_base"),
      query: z.string().trim().max(160).optional(),
      category: z.string().trim().max(40).optional(),
      limit: z.number().int().min(1).max(25).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("list_projects"),
    })
    .strict(),
  z
    .object({
      action: z.literal("save_project"),
      project_id: z.string().uuid().optional(),
      name: z.string().trim().min(1).max(120),
      instructions: z.string().trim().max(4000).optional(),
      pinned_files: z
        .array(
          z.object({
            name: z.string().trim().min(1).max(160),
            kind: z.string().trim().max(40).optional(),
            storage_path: z.string().trim().max(400).optional(),
            summary: z.string().trim().max(1000).optional(),
          }),
        )
        .max(10)
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("delete_project"),
      project_id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("list_teaching_queue"),
      department: z.string().trim().max(60).optional(),
      status: z.string().trim().max(40).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("approve_teaching_entry"),
      unanswered_id: z.string().uuid(),
      title: z.string().trim().min(3).max(160),
      approved_answer: z.string().trim().min(10).max(4000),
      category: z.string().trim().max(40).optional(),
      department: z.string().trim().max(60).optional(),
      source_doc: z.string().trim().max(200).optional(),
      screen_path: z.string().trim().max(120).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("my_taught_updates"),
    })
    .strict(),
  z
    .object({
      action: z.literal("real_use_dashboard"),
      days: z.number().int().min(1).max(90).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("get_push_prefs"),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_push_prefs"),
      push_enabled: z.boolean().optional(),
      morning_brief_push: z.boolean().optional(),
      taught_updates_push: z.boolean().optional(),
      soft_prompt_shown: z.boolean().optional(),
    })
    .strict(),
]);

export type RequestBody = z.infer<typeof RequestSchema>;

