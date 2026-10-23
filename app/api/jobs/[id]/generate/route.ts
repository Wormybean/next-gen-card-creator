import { aiError } from "@/lib/ai-errors";
import { withApiKeys } from "@/lib/generate";
import { generateForJob, type GenerateRequest } from "@/lib/service";

export const maxDuration = 300;

/**
 * Answers in lines of JSON as the work goes: `{"progress": …}` while the AI writes (so the page
 * can show it hasn't stalled), then `{"result": …}` or `{"error": …, "status": …}`.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/generate">) {
  const { id } = await ctx.params;
  const body = (await request.json()) as GenerateRequest;
  const key = request.headers.get("x-openrouter-key")?.trim() || null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: object) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      try {
        send({ result: await withApiKeys({ openRouter: key }, () => generateForJob(id, body, (progress) => send({ progress }))) });
      } catch (e) {
        send(aiError(e));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform" } });
}
