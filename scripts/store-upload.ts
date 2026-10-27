import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/*
 * 把打好的扩展 zip 传到 Chrome 应用商店并提交审核。发版工作流（.github/workflows/store.yml）调它，
 * 也可以在本机跑：
 *
 *   CWS_SERVICE_ACCOUNT_JSON="$(cat key.json)" CWS_PUBLISHER_ID=... \
 *     node --experimental-strip-types scripts/store-upload.ts lectern-extension-vX.Y.Z.zip
 *
 * 用的是商店 API 的 V2（chromewebstore.googleapis.com/v2）和服务账号：服务账号的密钥不会过期，
 * 不像 OAuth 的 refresh token 那样在「测试中」的同意屏幕下七天就失效。凭据怎么建见 docs/chrome-web-store.md。
 *
 * Review is always required. By default, a pending review blocks another upload.
 * An explicit --replace-pending=VERSION may replace that exact pending revision.
 */

/** 商店里这个扩展的 ID。公开的（就是商店网址里那一串），不算机密。 */
export const EXTENSION_ID = "fpplijdeabekpbadojohidampfnjhcdf";
const API = "https://chromewebstore.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

/** 服务账号密钥文件里用得到的三个字段。 */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface UploadDeps {
  fetch: typeof fetch;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

const DEFAULT_DEPS: UploadDeps = {
  fetch: (...args) => fetch(...args),
  now: Date.now,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
};

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/** 服务账号换访问令牌用的那张自签 JWT（RS256）。十分钟有效，够传一个包。 */
export function signedJwt(sa: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const claims = { iss: sa.client_email, scope: SCOPE, aud: tokenUri(sa), iat, exp: iat + 600 };
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  return `${unsigned}.${signature}`;
}

const tokenUri = (sa: ServiceAccount): string => sa.token_uri ?? "https://oauth2.googleapis.com/token";

/** 非 2xx 一律带着响应体报错：商店的报错原因（版本号没涨、上一版在审）都写在体里。 */
async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} failed (HTTP ${res.status}): ${text.slice(0, 2000)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${what} returned a non-JSON response: ${text.slice(0, 500)}`);
  }
}

async function accessToken(sa: ServiceAccount, deps: UploadDeps): Promise<string> {
  const res = await deps.fetch(tokenUri(sa), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedJwt(sa, deps.now()) }),
  });
  const token = (await json(res, "Exchange access token")).access_token;
  if (typeof token !== "string" || !token) throw new Error("Access token exchange: response has no access_token");
  return token;
}

const inProgress = (state: unknown): boolean => typeof state === "string" && state.includes("IN_PROGRESS");
const failed = (state: unknown): boolean => typeof state === "string" && /FAIL|NOT_FOUND/.test(state);

export interface UploadOptions {
  sa: ServiceAccount;
  publisherId: string;
  zip: Uint8Array;
  /** false 时只上传成草稿，不提交审核。 */
  publish?: boolean;
  extensionId?: string;
  /** Cancel only this exact pending version before submitting its replacement. Never enabled by default. */
  replacePendingVersion?: string;
}

interface RevisionStatus { state?: string; distributionChannels?: { crxVersion?: string }[] }

async function replacePendingReview(item: string, auth: Record<string, string>, version: string, deps: UploadDeps): Promise<void> {
  const status = async (): Promise<RevisionStatus | undefined> => {
    const result = await json(await deps.fetch(`${API}/v2/${item}:fetchStatus`, { headers: auth }), "Check submission status");
    return result.submittedItemRevisionStatus as RevisionStatus | undefined;
  };
  const matches = (revision: RevisionStatus): boolean => {
    const channels = revision.distributionChannels;
    return Array.isArray(channels) && channels.length > 0 && channels.every(channel => channel?.crxVersion === version);
  };
  const pending = await status();
  if (!pending || pending.state === "CANCELLED") {
    deps.log("No pending submission to replace.");
    return;
  }
  if (pending.state !== "PENDING_REVIEW" || !matches(pending)) {
    throw new Error(`Refusing to cancel: the active submission is not pending version ${version}. Check the developer dashboard.`);
  }
  // Official V2 API: empty request and response bodies. Published revisions are not changed.
  const canceled = await deps.fetch(`${API}/v2/${item}:cancelSubmission`, { method: "POST", headers: auth });
  if (!canceled.ok) await json(canceled, "Cancel pending review");
  else await canceled.text();
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = await status();
    if (!current || current.state === "CANCELLED") {
      deps.log(`Canceled pending review for ${version}. Uploading the replacement.`);
      return;
    }
    if (current.state !== "PENDING_REVIEW" || !matches(current)) {
      throw new Error("Submission changed while canceling. No replacement was uploaded; check the developer dashboard.");
    }
    if (attempt < 29) await deps.wait(1_000);
  }
  throw new Error("The previous submission is still pending after cancellation. No replacement was uploaded.");
}

/** 上传、等商店处理完、提交审核。返回提交后商店给的状态。 */
export async function uploadToStore(opts: UploadOptions, deps: UploadDeps = DEFAULT_DEPS): Promise<{ crxVersion: string; state: string }> {
  if (opts.replacePendingVersion !== undefined &&
      (opts.publish === false || !/^\d+(?:\.\d+){0,3}$/.test(opts.replacePendingVersion))) {
    throw new Error("Replacing a pending review requires its exact numeric version and a review submission (not --no-publish).");
  }
  const item = `publishers/${opts.publisherId}/items/${opts.extensionId ?? EXTENSION_ID}`;
  const auth = { authorization: `Bearer ${await accessToken(opts.sa, deps)}` };
  if (opts.replacePendingVersion !== undefined) await replacePendingReview(item, auth, opts.replacePendingVersion, deps);

  const uploaded = await json(
    await deps.fetch(`${API}/upload/v2/${item}:upload`, { method: "POST", headers: { ...auth, "content-type": "application/zip" }, body: opts.zip as BodyInit }),
    "Upload",
  );
  deps.log(`Upload: ${JSON.stringify(uploaded)}`);
  let state = uploaded.uploadState;
  // 大包是异步处理的：商店先回一个「处理中」，要自己去问结果
  for (let i = 0; inProgress(state) && i < 30; i++) {
    await deps.wait(5_000);
    const status = await json(await deps.fetch(`${API}/v2/${item}:fetchStatus`, { headers: auth }), "Check upload status");
    state = status.lastAsyncUploadState;
    deps.log(`Processing: ${String(state)}`);
  }
  if (inProgress(state)) throw new Error("Store processing exceeded 2.5 minutes. Check the developer dashboard later.");
  if (failed(state)) throw new Error(`The store rejected this package: ${String(state)}`);
  const crxVersion = typeof uploaded.crxVersion === "string" ? uploaded.crxVersion : "";

  if (opts.publish === false) return { crxVersion, state: "Uploaded only; not submitted for review" };
  const published = await json(
    await deps.fetch(`${API}/v2/${item}:publish`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" }),
    "Submit for review",
  );
  deps.log(`Review submission: ${JSON.stringify(published)}`);
  return { crxVersion, state: String(published.state ?? "") };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const raw = process.env.CWS_SERVICE_ACCOUNT_JSON;
  const publisherId = process.env.CWS_PUBLISHER_ID;
  if (!file || !raw || !publisherId) {
    console.error("Usage: CWS_SERVICE_ACCOUNT_JSON=<key-file-contents> CWS_PUBLISHER_ID=<publisher-id> store-upload.ts <zip> [--no-publish] [--replace-pending=VERSION]");
    process.exit(2);
  }
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(raw) as ServiceAccount;
  } catch {
    throw new Error("CWS_SERVICE_ACCOUNT_JSON must contain the complete service account key file as valid JSON");
  }
  if (!sa.client_email || !sa.private_key) throw new Error("CWS_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  const result = await uploadToStore({
    sa,
    publisherId: publisherId.trim(),
    zip: readFileSync(file),
    publish: !args.includes("--no-publish"),
    ...(args.some(a => a.startsWith("--replace-pending="))
      ? { replacePendingVersion: args.find(a => a.startsWith("--replace-pending="))!.slice("--replace-pending=".length) } : {}),
    ...(process.env.CWS_EXTENSION_ID ? { extensionId: process.env.CWS_EXTENSION_ID } : {}),
  });
  console.log(`Version ${result.crxVersion || "?"}: ${result.state}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
