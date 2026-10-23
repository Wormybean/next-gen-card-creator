import { hasCollection } from "@/lib/collection";
import { blobStoreOn } from "@/lib/store";

/** What this copy of the app needs from the visitor: their own key, and how files travel. */
export async function GET() {
  const online = !!process.env.VERCEL;
  return Response.json({
    online,
    /** Large files go straight to Vercel Blob (a request to this server is capped at 4.5 MB). */
    directUpload: blobStoreOn(),
    /** True only on your own computer with OPENROUTER_API_KEY (or GEMINI_API_KEY) in .env.local. */
    serverKey: !online && !!(process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY),
    hasCollection: hasCollection(),
  });
}
