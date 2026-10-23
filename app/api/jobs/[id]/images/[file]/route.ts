import { imageContentType, imageFile } from "@/lib/jobs";

export async function GET(_req: Request, ctx: RouteContext<"/api/jobs/[id]/images/[file]">) {
  const { id, file } = await ctx.params;
  try {
    const data = await imageFile(id, file);
    // Names are unique per upload and never reused, so the picture can be cached for good.
    return new Response(Buffer.from(data), {
      headers: { "Content-Type": imageContentType(file), "Cache-Control": "max-age=31536000, immutable" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
