import { deleteOlderThan } from "@/lib/store";

/** Run nightly by Vercel Cron (vercel.json): deletes every stored file older than a day. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Not allowed", { status: 401 });
  }
  return Response.json({ removed: await deleteOlderThan(24 * 60 * 60 * 1000) });
}
