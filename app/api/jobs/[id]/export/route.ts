import { exportCards } from "@/lib/export";
import { getJob } from "@/lib/jobs";
import type { DraftCard } from "@/lib/rules";

export const maxDuration = 120;

export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/export">) {
  const { id } = await ctx.params;
  const body = (await request.json()) as { deck: string; tags: string[]; cards: DraftCard[] };
  try {
    const job = await getJob(id);
    const apkg = await exportCards(job, body.deck.trim() || "Next-gen Card Creator", body.tags, body.cards);
    const filename = `${job.name.replace(/[^\w\- ]+/g, "").trim() || "cards"}.apkg`;
    // Sent as a stream: online, a plain response is capped at 4.5 MB and a deck with slide pictures can be bigger.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(apkg);
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Length": String(apkg.byteLength),
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
