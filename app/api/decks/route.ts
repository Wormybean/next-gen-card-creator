import { collection } from "@/lib/collection";

export async function GET() {
  try {
    return Response.json({ decks: collection.decks() });
  } catch (e) {
    return Response.json({ decks: [], error: (e as Error).message });
  }
}
