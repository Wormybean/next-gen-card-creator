// Files the visitor sent to be read: either inside the request itself (your own computer,
// or small files) or already uploaded straight to storage (online, where a request to this
// server is capped at 4.5 MB). The storage copy is deleted as soon as it has been read.

import { deleteFile, getFile } from "./store";

export type IncomingFile = { name: string; data: Uint8Array };
export type StoredRef = { name: string; key: string };

const KEY = /^incoming\/[0-9a-f-]{36}\/[^/]+$/i;

export async function takeStored(refs: StoredRef[]): Promise<IncomingFile[]> {
  return Promise.all(
    refs.map(async ({ name, key }) => {
      if (!KEY.test(key)) throw new Error("Bad file reference");
      const data = await getFile(key);
      if (!data) throw new Error(`${name} didn't arrive: try again`);
      await deleteFile(key);
      return { name, data };
    }),
  );
}
