// Where a job's files live (job.json, slide pictures, draft, uploads, exports).
//
// On your own computer: plain files under config.jobsDir().
// Online (Vercel can't keep files between requests): a private Vercel Blob store, used
// whenever BLOB_READ_WRITE_TOKEN is set. Keys look like "jobs/<id>/job.json".

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BlobNotFoundError, del, get, list, put } from "@vercel/blob";
import { config } from "./config";

export const blobStoreOn = () => !!process.env.BLOB_READ_WRITE_TOKEN;

const diskPath = (key: string) => {
  if (key.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Bad storage key");
  return path.join(config.jobsDir(), ...key.split("/"));
};

export async function putFile(key: string, data: Uint8Array | string, contentType?: string): Promise<void> {
  if (blobStoreOn()) {
    await put(key, typeof data === "string" ? data : Buffer.from(data), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
    });
    return;
  }
  const file = diskPath(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

/** The file's bytes, or null if there is no such file. */
export async function getFile(key: string): Promise<Uint8Array | null> {
  if (blobStoreOn()) {
    try {
      const result = await get(key, { access: "private", useCache: false });
      if (!result || result.statusCode !== 200) return null;
      return new Uint8Array(await new Response(result.stream).arrayBuffer());
    } catch (e) {
      if (e instanceof BlobNotFoundError) return null;
      throw e;
    }
  }
  try {
    return new Uint8Array(await readFile(diskPath(key)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function getText(key: string): Promise<string | null> {
  const data = await getFile(key);
  return data && new TextDecoder().decode(data);
}

export async function deleteFile(key: string): Promise<void> {
  if (blobStoreOn()) await del(key);
  else await rm(diskPath(key), { force: true });
}

/** Deletes every file whose key starts with `prefix/` (e.g. everything stored for one job). */
export async function deleteFolder(prefix: string): Promise<void> {
  if (blobStoreOn()) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: `${prefix}/`, cursor, limit: 1000 });
      if (page.blobs.length) await del(page.blobs.map((b) => b.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return;
  }
  await rm(diskPath(prefix), { recursive: true, force: true });
}

/** Deletes everything older than `maxAgeMs` (online only; the nightly clean-up uses this). */
export async function deleteOlderThan(maxAgeMs: number): Promise<number> {
  if (!blobStoreOn()) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await list({ cursor, limit: 1000 });
    const old = page.blobs.filter((b) => b.uploadedAt.getTime() < cutoff).map((b) => b.pathname);
    if (old.length) {
      await del(old);
      removed += old.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return removed;
}
