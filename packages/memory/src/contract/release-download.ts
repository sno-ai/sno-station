import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function readReleaseManifest(url: string, userAgent: string, timeoutMs: number): Promise<{ status: number; ok: boolean; document?: unknown }> {
  const response = await fetch(url, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return { status: response.status, ok: false };
  const document: unknown = await response.json();
  return { status: response.status, ok: true, document };
}

export async function downloadReleaseArchive(url: string, destination: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) throw new Error(`tarball fetch failed: ${response.status}`);
  const hasher = createHash("sha512");
  const source = Readable.from(response.body);
  source.on("data", (chunk: Buffer) => hasher.update(chunk));
  await pipeline(source, createWriteStream(destination));
  return hasher.digest("base64");
}
