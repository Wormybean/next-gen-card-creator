import { takeStored, type IncomingFile, type StoredRef } from "@/lib/incoming";
import { createJob, type UploadMode } from "@/lib/jobs";

export const maxDuration = 120;

const asMode = (m: unknown): UploadMode | undefined => (m === "lecture" || m === "csbl" ? m : undefined);

export async function POST(request: Request) {
  try {
    let files: IncomingFile[];
    let mode: UploadMode | undefined;
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = (await request.json()) as { files: StoredRef[]; mode?: string };
      files = await takeStored(body.files);
      mode = asMode(body.mode);
    } else {
      const form = await request.formData();
      files = await Promise.all(
        form
          .getAll("files")
          .filter((f): f is File => f instanceof File && f.size > 0)
          .map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })),
      );
      mode = asMode(form.get("mode"));
    }
    return Response.json({ job: await createJob(files, mode) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
