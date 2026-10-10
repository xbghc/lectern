import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { EXTENSION_ID, signedJwt, uploadToStore } from "../scripts/store-upload.ts";
import type { ServiceAccount, UploadDeps } from "../scripts/store-upload.ts";

/*
 * 商店那头是假的：这里验的是我们发出去的东西（JWT 签得对不对、三个请求的地址和顺序、
 * 「处理中」会不会去追问、失败会不会照实报），不是商店会回什么。
 */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA: ServiceAccount = {
  client_email: "ci@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  token_uri: "https://token.test/token",
};
const ITEM = `publishers/pub-1/items/${EXTENSION_ID}`;

interface Call { url: string; method: string; auth: string | null; body: unknown }

function fake(replies: Record<string, Array<{ status?: number; body: unknown }>>): { deps: UploadDeps; calls: Call[]; waits: number[] } {
  const calls: Call[] = [];
  const waits: number[] = [];
  const deps: UploadDeps = {
    now: () => 1_700_000_000_000,
    wait: async (ms) => { waits.push(ms); },
    log: () => {},
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body: init?.body });
      const queue = replies[url];
      const reply = queue?.shift();
      if (!reply) throw new Error(`没料到的请求：${url}`);
      return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }) as typeof fetch,
  };
  return { deps, calls, waits };
}

test("换令牌用的 JWT：RS256 签名验得过，声明里是服务账号、商店的 scope 和令牌地址", () => {
  const jwt = signedJwt(SA, 1_700_000_000_000);
  const [header, claims, signature] = jwt.split(".") as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
    iss: SA.client_email, scope: "https://www.googleapis.com/auth/chromewebstore", aud: "https://token.test/token",
    iat: 1_700_000_000, exp: 1_700_000_600,
  });
  assert.equal(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url")), true);
});

test("一次顺利的发布：换令牌 → 传包 → 提交审核，后两步都带着令牌", async () => {
  const zip = new Uint8Array([80, 75, 3, 4]);
  const { deps, calls } = fake({
    "https://token.test/token": [{ body: { access_token: "tok" } }],
    [`https://chromewebstore.googleapis.com/upload/v2/${ITEM}:upload`]: [{ body: { crxVersion: "0.3.18", uploadState: "SUCCEEDED" } }],
    [`https://chromewebstore.googleapis.com/v2/${ITEM}:publish`]: [{ body: { state: "PENDING_REVIEW" } }],
  });
  const result = await uploadToStore({ sa: SA, publisherId: "pub-1", zip }, deps);
  assert.deepEqual(result, { crxVersion: "0.3.18", state: "PENDING_REVIEW" });
  assert.deepEqual(calls.map((c) => [c.method, c.auth]), [["POST", null], ["POST", "Bearer tok"], ["POST", "Bearer tok"]]);
  assert.equal(calls[1]!.body, zip, "传上去的就是那个 zip 的字节");
  assert.match(String(calls[0]!.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
});

test("商店说「处理中」：隔几秒去问，处理完了再提交", async () => {
  const { deps, calls, waits } = fake({
    "https://token.test/token": [{ body: { access_token: "tok" } }],
    [`https://chromewebstore.googleapis.com/upload/v2/${ITEM}:upload`]: [{ body: { crxVersion: "0.3.18", uploadState: "UPLOAD_IN_PROGRESS" } }],
    [`https://chromewebstore.googleapis.com/v2/${ITEM}:fetchStatus`]: [{ body: { lastAsyncUploadState: "UPLOAD_IN_PROGRESS" } }, { body: { lastAsyncUploadState: "SUCCEEDED" } }],
    [`https://chromewebstore.googleapis.com/v2/${ITEM}:publish`]: [{ body: { state: "PENDING_REVIEW" } }],
  });
  await uploadToStore({ sa: SA, publisherId: "pub-1", zip: new Uint8Array(1) }, deps);
  assert.deepEqual(waits, [5_000, 5_000]);
  assert.equal(calls.at(-1)!.url.endsWith(":publish"), true);
});

test("商店拒收（比如版本号没涨、上一版还在审）：带着商店给的原因报错，不去提交审核", async () => {
  const { deps, calls } = fake({
    "https://token.test/token": [{ body: { access_token: "tok" } }],
    [`https://chromewebstore.googleapis.com/upload/v2/${ITEM}:upload`]: [{ status: 400, body: { error: { message: "Item is pending review" } } }],
  });
  await assert.rejects(uploadToStore({ sa: SA, publisherId: "pub-1", zip: new Uint8Array(1) }, deps), /上传失败（HTTP 400）.*pending review/);
  assert.equal(calls.some((c) => c.url.endsWith(":publish")), false);
});

test("处理失败的包不提交；只上传不提交时也不碰 publish", async () => {
  const bad = fake({
    "https://token.test/token": [{ body: { access_token: "tok" } }],
    [`https://chromewebstore.googleapis.com/upload/v2/${ITEM}:upload`]: [{ body: { uploadState: "FAILED" } }],
  });
  await assert.rejects(uploadToStore({ sa: SA, publisherId: "pub-1", zip: new Uint8Array(1) }, bad.deps), /没收下/);
  const draft = fake({
    "https://token.test/token": [{ body: { access_token: "tok" } }],
    [`https://chromewebstore.googleapis.com/upload/v2/${ITEM}:upload`]: [{ body: { crxVersion: "0.3.18", uploadState: "SUCCEEDED" } }],
  });
  const result = await uploadToStore({ sa: SA, publisherId: "pub-1", zip: new Uint8Array(1), publish: false }, draft.deps);
  assert.equal(result.state, "只上传，未提交审核");
  assert.equal(draft.calls.length, 2);
});
