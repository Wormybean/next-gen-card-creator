import { getJob, saveDraft, type SavedDraft } from "@/lib/jobs";

export async function PUT(request: Request, ctx: RouteContext<"/api/jobs/[id]/draft">) {
  const { id } = await ctx.params;
  try {
    await getJob(id); // only drafts for jobs that exist
    await saveDraft(id, (await request.json()) as SavedDraft);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }
}
