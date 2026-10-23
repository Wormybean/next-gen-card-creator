// lib/fetch-page.ts for the add-on: Anki's Python fetches the page, since a page in Anki's
// window can't read other sites.

import { fromBase64 } from "../../../lib/base64";
import type { FetchedPage } from "../../../lib/fetch-page";
import { py } from "./bridge";

export async function fetchPage(url: string): Promise<FetchedPage> {
  const page = await py<Omit<FetchedPage, "data"> & { data: string }>("fetchUrl", url);
  return { ...page, data: fromBase64(page.data) };
}
