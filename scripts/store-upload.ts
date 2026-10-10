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
 * 审核跳不过：这里做的只是「上传 + 点提交」。商店里上一版还在审的时候传不上去，那种情况这里照实报错退出，
 * 等上一版出了结果，在 Actions 页面对同一个标签手动重跑 store.yml 就行。
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
  if (!res.ok) throw new Error(`${what}失败（HTTP ${res.status}）：${text.slice(0, 2000)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${what}的响应不是 JSON：${text.slice(0, 500)}`);
  }
}

async function accessToken(sa: ServiceAccount, deps: UploadDeps): Promise<string> {
  const res = await deps.fetch(tokenUri(sa), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedJwt(sa, deps.now()) }),
  });
  const token = (await json(res, "换取访问令牌")).access_token;
  if (typeof token !== "string" || !token) throw new Error("换取访问令牌：响应里没有 access_token");
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
}

/** 上传、等商店处理完、提交审核。返回提交后商店给的状态。 */
export async function uploadToStore(opts: UploadOptions, deps: UploadDeps = DEFAULT_DEPS): Promise<{ crxVersion: string; state: string }> {
  const item = `publishers/${opts.publisherId}/items/${opts.extensionId ?? EXTENSION_ID}`;
  const auth = { authorization: `Bearer ${await accessToken(opts.sa, deps)}` };

  const uploaded = await json(
    await deps.fetch(`${API}/upload/v2/${item}:upload`, { method: "POST", headers: { ...auth, "content-type": "application/zip" }, body: opts.zip as BodyInit }),
    "上传",
  );
  deps.log(`上传：${JSON.stringify(uploaded)}`);
  let state = uploaded.uploadState;
  // 大包是异步处理的：商店先回一个「处理中」，要自己去问结果
  for (let i = 0; inProgress(state) && i < 30; i++) {
    await deps.wait(5_000);
    const status = await json(await deps.fetch(`${API}/v2/${item}:fetchStatus`, { headers: auth }), "查询上传状态");
    state = status.lastAsyncUploadState;
    deps.log(`处理中：${String(state)}`);
  }
  if (inProgress(state)) throw new Error("商店处理这个包超过两分半还没完，稍后到开发者后台看结果");
  if (failed(state)) throw new Error(`商店没收下这个包：${String(state)}`);
  const crxVersion = typeof uploaded.crxVersion === "string" ? uploaded.crxVersion : "";

  if (opts.publish === false) return { crxVersion, state: "只上传，未提交审核" };
  const published = await json(
    await deps.fetch(`${API}/v2/${item}:publish`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" }),
    "提交审核",
  );
  deps.log(`提交审核：${JSON.stringify(published)}`);
  return { crxVersion, state: String(published.state ?? "") };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const raw = process.env.CWS_SERVICE_ACCOUNT_JSON;
  const publisherId = process.env.CWS_PUBLISHER_ID;
  if (!file || !raw || !publisherId) {
    console.error("用法：CWS_SERVICE_ACCOUNT_JSON=<密钥文件内容> CWS_PUBLISHER_ID=<发布者 ID> store-upload.ts <zip> [--no-publish]");
    process.exit(2);
  }
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(raw) as ServiceAccount;
  } catch {
    throw new Error("CWS_SERVICE_ACCOUNT_JSON 不是合法的 JSON：要的是服务账号密钥文件的全部内容");
  }
  if (!sa.client_email || !sa.private_key) throw new Error("CWS_SERVICE_ACCOUNT_JSON 里缺 client_email 或 private_key");
  const result = await uploadToStore({
    sa,
    publisherId: publisherId.trim(),
    zip: readFileSync(file),
    publish: !args.includes("--no-publish"),
    ...(process.env.CWS_EXTENSION_ID ? { extensionId: process.env.CWS_EXTENSION_ID } : {}),
  });
  console.log(`版本 ${result.crxVersion || "?"}：${result.state}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
