// lib/store.ts for the add-on: a job's files live in the add-on's user_files folder, which
// Anki keeps when the add-on updates. Same keys as the web version ("jobs/<id>/job.json").

import { fromBase64, toBase64 } from "../../../lib/base64";
import { py } from "./bridge";

export const blobStoreOn = () => false;

export async function putFile(key: string, data: Uint8Array | string): Promise<void> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  await py("putFile", { key, data: toBase64(bytes) });
}

/** The file's bytes, or null if there is no such file. */
export async function getFile(key: string): Promise<Uint8Array | null> {
  const data = await py<string | null>("getFile", key);
  return data === null ? null : fromBase64(data);
}

export async function getText(key: string): Promise<string | null> {
  const data = await getFile(key);
  return data && new TextDecoder().decode(data);
}

export async function deleteFile(key: string): Promise<void> {
  await py("deleteFile", key);
}

export async function deleteFolder(prefix: string): Promise<void> {
  await py("deleteFolder", prefix);
}

export async function deleteOlderThan(): Promise<number> {
  return 0;
}
