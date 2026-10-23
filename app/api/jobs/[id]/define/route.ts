import { aiErrorResponse } from "@/lib/ai-errors";
import { withApiKeys } from "@/lib/generate";
import { defineForJob, type DefineRequest } from "@/lib/service";

export const maxDuration = 60;

/** A short definition of a term the user highlighted on a card, for its back. */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/define">) {
  const { id } = await ctx.params;
  const body = (await request.json()) as DefineRequest;
  try {
    const key = request.headers.get("x-openrouter-key")?.trim() || null;
    return Response.json(await withApiKeys({ openRouter: key }, () => defineForJob(id, body)));
  } catch (e) {
    return aiErrorResponse(e);
  }
}
