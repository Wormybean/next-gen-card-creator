import { takeStored } from "@/lib/incoming";
import { addReadingUpload } from "@/lib/service";

export const maxDuration = 60;

/** The user's own copy of a pre-reading whose link wouldn't open (PDF or Word). */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/readings">) {
  const { id } = await ctx.params;
  try {
    let url: string;
    let name: string;
    let data: Uint8Array;
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = (await request.json()) as { url: string; name: string; key: string };
      url = body.url;
      [{ name, data }] = await takeStored([{ name: body.name, key: body.key }]);
    } else {
      const form = await request.formData();
      url = String(form.get("url") ?? "");
      const file = form.get("file");
      if (!(file instanceof File) || !file.size) throw new Error("No file chosen");
      name = file.name;
      data = new Uint8Array(await file.arrayBuffer());
    }
    return Response.json({ reading: await addReadingUpload(id, url, name, data) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
