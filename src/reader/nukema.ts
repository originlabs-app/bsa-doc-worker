import { open, rm } from "node:fs/promises";

import { streamResponseToFile } from "./download.js";

const NUKEMA_TOKEN_URL =
  "https://identite.nukema.com/auth/realms/anm/protocol/openid-connect/token";
const NUKEMA_REQUEST_TOKEN_URL =
  "https://marches-publics.nukema.com/core/attachments/requestToken";
const NUKEMA_DOWNLOAD_URL =
  "https://marches-publics.nukema.com/core/attachments/download";

export class NukemaSourceExpiredError extends Error {
  readonly code = "NUKEMA_SOURCE_EXPIRED";

  constructor(public readonly status: number) {
    super("NUKEMA_SOURCE_EXPIRED");
    this.name = "NukemaSourceExpiredError";
  }
}

export class NukemaSourceUnavailableError extends Error {
  readonly code = "NUKEMA_SOURCE_UNAVAILABLE";

  constructor(public readonly contentType: string) {
    super("NUKEMA_SOURCE_UNAVAILABLE");
    this.name = "NukemaSourceUnavailableError";
  }
}

function resolveSourceReference(input: {
  sourceReference?: string | null;
  sourceUrl?: string | null;
}): string {
  const explicit = input.sourceReference?.trim();
  if (explicit) return explicit;
  const sourceUrl = input.sourceUrl?.trim();
  if (!sourceUrl) throw new Error("NUKEMA_SOURCE_REFERENCE_MISSING");
  const reference = new URL(sourceUrl).searchParams.get("id")?.trim();
  if (!reference) throw new Error("NUKEMA_SOURCE_REFERENCE_MISSING");
  return reference;
}

async function authenticate(input: {
  username: string;
  password: string;
  fetchFn: typeof fetch;
  signal: AbortSignal;
}): Promise<string> {
  const response = await input.fetchFn(NUKEMA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "angular",
      username: input.username,
      password: input.password,
    }),
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`NUKEMA_AUTH_${response.status}`);
  const json = (await response.json()) as { access_token?: unknown };
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new Error("NUKEMA_AUTH_TOKEN_MISSING");
  }
  return json.access_token;
}

async function requestDownloadToken(input: {
  accessToken: string;
  fetchFn: typeof fetch;
  signal: AbortSignal;
}): Promise<string> {
  const response = await input.fetchFn(NUKEMA_REQUEST_TOKEN_URL, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`NUKEMA_DOWNLOAD_TOKEN_${response.status}`);
  const raw = (await response.text()).trim();
  let token = raw;
  try {
    const parsed = JSON.parse(raw) as
      | string
      | { token?: unknown; downloadToken?: unknown };
    if (typeof parsed === "string") token = parsed;
    else if (typeof parsed.downloadToken === "string") token = parsed.downloadToken;
    else if (typeof parsed.token === "string") token = parsed.token;
  } catch {
    // Nukema sometimes returns the token as plain text.
  }
  if (!token) throw new Error("NUKEMA_DOWNLOAD_TOKEN_MISSING");
  return token;
}

async function fileMagic(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const bytes = new Uint8Array(4);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.slice(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function hasExpectedBinaryMagic(fileName: string, bytes: Uint8Array): boolean {
  const normalized = fileName.trim().toLowerCase();
  if (normalized.endsWith(".pdf")) {
    return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  }
  if (/\.(zip|docx|xlsx|ods)$/.test(normalized)) {
    return bytes[0] === 0x50 && bytes[1] === 0x4b;
  }
  if (/\.(doc|xls)$/.test(normalized)) {
    return bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  }
  return false;
}

async function assertPayload(input: {
  fileName: string | null | undefined;
  contentType: string;
  targetPath: string;
}): Promise<void> {
  if (!input.fileName) return;
  const normalizedType = input.contentType.toLowerCase();
  if (!normalizedType.includes("text/plain") && !normalizedType.includes("text/html")) {
    return;
  }
  const normalizedName = input.fileName.trim().toLowerCase();
  if (!/\.(zip|pdf|docx|xlsx|ods|doc|xls)$/.test(normalizedName)) return;
  if (hasExpectedBinaryMagic(normalizedName, await fileMagic(input.targetPath))) return;
  throw new NukemaSourceUnavailableError(input.contentType);
}

export async function downloadNukemaSourceToFile(input: {
  username: string;
  password: string;
  sourceReference?: string | null;
  sourceUrl?: string | null;
  fileName?: string | null;
  targetPath: string;
  maxBytes: number;
  signal: AbortSignal;
  onProgress?: (bytesRead: number) => Promise<void> | void;
  fetchFn?: typeof fetch;
}): Promise<{ bytes: number; contentType: string }> {
  const fetchFn = input.fetchFn ?? fetch;
  const reference = resolveSourceReference(input);
  const accessToken = await authenticate({
    username: input.username,
    password: input.password,
    fetchFn,
    signal: input.signal,
  });
  const downloadToken = await requestDownloadToken({
    accessToken,
    fetchFn,
    signal: input.signal,
  });
  const response = await fetchFn(
    `${NUKEMA_DOWNLOAD_URL}?id=${encodeURIComponent(reference)}&token=${encodeURIComponent(downloadToken)}`,
    { signal: input.signal },
  );
  if ([403, 404, 410].includes(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw new NukemaSourceExpiredError(response.status);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`NUKEMA_DOWNLOAD_${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  try {
    const bytes = await streamResponseToFile(
      response,
      input.targetPath,
      input.maxBytes,
      input.onProgress,
    );
    await assertPayload({
      fileName: input.fileName,
      contentType,
      targetPath: input.targetPath,
    });
    return { bytes, contentType };
  } catch (error) {
    await rm(input.targetPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
