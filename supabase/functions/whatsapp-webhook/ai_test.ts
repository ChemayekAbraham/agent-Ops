import { assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildWhatsAppAiReply } from "./ai.ts";

const realFetch = globalThis.fetch;

/** Installs a fake gateway so the test never leaves the sandbox. */
function stubFetch(reply: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

/** A streamed gateway body, deliberately split so a frame straddles two chunks. */
function streamed(frames: string[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(new TextEncoder().encode(f));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

const DELTA = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

Deno.test("whatsapp ai: streamed deltas become one reply", async () => {
  const { restore } = stubFetch(
    streamed([
      DELTA("Rent "),
      'data: {"choices":[{"delta":{"con', // frame cut in half
      'tent":" Plans"}}]}\n\n',
      ": keep-alive\n\n",
      DELTA(" here"),
      "data: [DONE]\n\n",
    ]),
  );
  try {
    const answer = await buildWhatsAppAiReply("k", "instructions", "question", new AbortController().signal);
    assertEquals(answer, "Rent Plans here");
  } finally {
    restore();
  }
});

Deno.test("whatsapp ai: asks the gateway for a streamed chat completion", async () => {
  const { calls, restore } = stubFetch(streamed([DELTA("ok")]));
  try {
    await buildWhatsAppAiReply("k", "system text", "user text", new AbortController().signal);
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0].url, "/v1/chat/completions");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    assertEquals(body.model, "openai/gpt-6-astra");
    assertEquals(body.stream, true);
    assertEquals(body.messages, [
      { role: "system", content: "system text" },
      { role: "user", content: "user text" },
    ]);
  } finally {
    restore();
  }
});

Deno.test("whatsapp ai: a refused request reports the status only", async () => {
  const { restore } = stubFetch(new Response("provider detail that must not leak", { status: 503 }));
  try {
    const err = await assertRejects(
      () => buildWhatsAppAiReply("k", "i", "q", new AbortController().signal),
      Error,
      "model request failed: 503",
    );
    assertEquals(String(err.message).includes("provider detail"), false);
  } finally {
    restore();
  }
});

Deno.test("whatsapp ai: an empty stream is an error, not a blank message", async () => {
  const { restore } = stubFetch(streamed(["data: [DONE]\n\n"]));
  try {
    await assertRejects(
      () => buildWhatsAppAiReply("k", "i", "q", new AbortController().signal),
      Error,
      "Empty AI response",
    );
  } finally {
    restore();
  }
});

Deno.test("whatsapp ai: a long answer is cut at 4000 characters", async () => {
  const { restore } = stubFetch(streamed([DELTA("a".repeat(5000)), "data: [DONE]\n\n"]));
  try {
    const answer = await buildWhatsAppAiReply("k", "i", "q", new AbortController().signal);
    assertEquals(answer.length, 4000);
  } finally {
    restore();
  }
});
