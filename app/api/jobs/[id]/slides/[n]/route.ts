import { slidePng } from "@/lib/jobs";

export async function GET(_req: Request, ctx: RouteContext<"/api/jobs/[id]/slides/[n]">) {
  const { id, n } = await ctx.params;
  try {
    const png = await slidePng(id, Number(n));
    return new Response(Buffer.from(png), { headers: { "Content-Type": "image/png", "Cache-Control": "max-age=86400" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
