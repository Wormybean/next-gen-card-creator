// Fetches a web page or PDF for a CSBL pre-reading. The add-on swaps this file for one that
// asks Anki to fetch, because a page in Anki's window can't read most other sites.

export type FetchedPage = { status: number; contentType: string; url: string; data: Uint8Array };

export async function fetchPage(url: string): Promise<FetchedPage> {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      Accept: "text/html,application/pdf;q=0.9,*/*;q=0.8",
    },
  });
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    url: res.url,
    data: new Uint8Array(await res.arrayBuffer()),
  };
}
