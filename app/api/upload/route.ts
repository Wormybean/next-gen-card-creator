import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { blobStoreOn } from "@/lib/store";

export const maxDuration = 60;

/** Hands the browser a short-lived token to send one PDF or Word file straight to Vercel Blob. */
export async function POST(request: Request) {
  if (!blobStoreOn()) return Response.json({ error: "Direct upload isn't set up" }, { status: 400 });
  const body = (await request.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!/^incoming\/[0-9a-f-]{36}\/[^/]+\.(pdf|docx)$/i.test(pathname)) throw new Error("Not an allowed file");
        return {
          allowedContentTypes: ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
          maximumSizeInBytes: 100 * 1024 * 1024,
          addRandomSuffix: false,
        };
      },
    });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
