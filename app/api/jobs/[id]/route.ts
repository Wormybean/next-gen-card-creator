import { deleteJob, getJob, loadDraft } from "@/lib/jobs";

export async function GET(_req: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  try {
    return Response.json({ job: await getJob(id), draft: await loadDraft(id) });
  } catch {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }
}

/** "Delete my files now": removes the slides, draft and uploaded readings for this job. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  try {
    await deleteJob(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
