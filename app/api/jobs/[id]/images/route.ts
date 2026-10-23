import { addPicture } from "@/lib/service";

/** A picture for a card: a slide crop or a pasted / dropped image. Desktop and local only. */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/images">) {
  const { id } = await ctx.params;
  if (process.env.VERCEL) return Response.json({ error: "Adding pictures works in the desktop app only" }, { status: 403 });
  try {
    const file = (await request.formData()).get("file");
    if (!(file instanceof File)) throw new Error("No picture sent");
    const name = await addPicture(id, new Uint8Array(await file.arrayBuffer()), file.type);
    return Response.json({ file: name });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
