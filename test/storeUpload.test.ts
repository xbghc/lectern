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
  await assert.rejects(uploadToStore({ sa: SA, publisherId: "pub-1", zip: new Uint8Array(1) }, deps), /Upload failed \(HTTP 400\).*pending review/);
  assert.equal(calls.some((c) => c.url.endsWith(":publish")), false);
});

test("处理失败的包不提交；只上传不提交时也不碰 publish", async () => {
  const bad = fake({
    "https://token.test/token": [{ body: { access_token: "tok" } }],
    [`https://chromewebstore.googleapis.com/upload/v2/${ITEM}:upload`]: [{ body: { uploadState: "FAILED" } }],
  });
  await assert.rejects(uploadToStore({ sa: SA, publisherId: "pub-1", zip: new Uint8Array(1) }, bad.deps), /store rejected/);
  const draft = fake({
    "https://token.test/token": [{ body: { access_token: "tok" } }],
    [`https://chromewebstore.googleapis.com/upload/v2/${ITEM}:upload`]: [{ body: { crxVersion: "0.3.18", uploadState: "SUCCEEDED" } }],
  });
  const result = await uploadToStore({ sa: SA, publisherId: "pub-1", zip: new Uint8Array(1), publish: false }, draft.deps);
  assert.equal(result.state, "Uploaded only; not submitted for review");
  assert.equal(draft.calls.length, 2);
});

const statusUrl = `https://chromewebstore.googleapis.com/v2/${ITEM}:fetchStatus`;
const cancelUrl = `https://chromewebstore.googleapis.com/v2/${ITEM}:cancelSubmission`;
const uploadUrl = `https://chromewebstore.googleapis.com/upload/v2/${ITEM}:upload`;
const publishUrl = `https://chromewebstore.googleapis.com/v2/${ITEM}:publish`;
const pending = (version = "0.3.19", state = "PENDING_REVIEW") => ({
  submittedItemRevisionStatus: { state, distributionChannels: [{ crxVersion: version }] },
});
const replacement = { sa: SA, publisherId: "pub-1", zip: new Uint8Array([80, 75]), replacePendingVersion: "0.3.19" };

test("explicit replacement cancels only the named pending version and waits before uploading", async () => {
  const { deps, calls, waits } = fake({
    "https://token.test/token": [{ body: { access_token: "tok" } }],
    [statusUrl]: [{ body: pending() }, { body: pending() }, { body: pending("0.3.19", "CANCELLED") }],
    [cancelUrl]: [{ body: "" }],
    [uploadUrl]: [{ body: { crxVersion: "0.3.20", uploadState: "SUCCEEDED" } }],
    [publishUrl]: [{ body: { state: "PENDING_REVIEW" } }],
  });
  assert.deepEqual(await uploadToStore(replacement, deps), { crxVersion: "0.3.20", state: "PENDING_REVIEW" });
  assert.deepEqual(calls.slice(1).map(c => c.url), [statusUrl, cancelUrl, statusUrl, statusUrl, uploadUrl, publishUrl]);
  assert.deepEqual(waits, [1_000]);
  assert.equal(calls[2]!.method, "POST");
  assert.equal(calls[2]!.auth, "Bearer tok");
  assert.equal(calls[2]!.body, undefined, "cancelSubmission requires an empty body");
});

test("replacement refuses a different, unknown or already approved revision", async () => {
  for (const body of [pending("0.3.20"), pending("0.3.19", "STAGED"),
    { submittedItemRevisionStatus: { state: "PENDING_REVIEW" } },
    { submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: "0.3.19" }, { crxVersion: "0.3.20" }] } }]) {
    const { deps, calls } = fake({
      "https://token.test/token": [{ body: { access_token: "tok" } }], [statusUrl]: [{ body }],
    });
    await assert.rejects(uploadToStore(replacement, deps), /Refusing to cancel/);
    assert.deepEqual(calls.map(c => c.url), ["https://token.test/token", statusUrl]);
  }
});

test("failed cancellation never uploads or submits a replacement", async () => {
  const { deps, calls } = fake({
    "https://token.test/token": [{ body: { access_token: "tok" } }], [statusUrl]: [{ body: pending() }],
    [cancelUrl]: [{ status: 403, body: { error: { message: "not permitted" } } }],
  });
  await assert.rejects(uploadToStore(replacement, deps), /Cancel pending review failed \(HTTP 403\)/);
  assert.equal(calls.at(-1)!.url, cancelUrl);
});

test("a changing or uncleared submission stops without canceling twice or uploading", async () => {
  for (const statuses of [[pending("0.3.20")], Array.from({ length: 30 }, () => pending())]) {
    const { deps, calls } = fake({
      "https://token.test/token": [{ body: { access_token: "tok" } }],
      [statusUrl]: [{ body: pending() }, ...statuses.map(body => ({ body }))], [cancelUrl]: [{ body: {} }],
    });
    await assert.rejects(uploadToStore(replacement, deps), /No replacement was uploaded/);
    assert.equal(calls.filter(c => c.url === cancelUrl).length, 1);
    assert.equal(calls.some(c => c.url === uploadUrl || c.url === publishUrl), false);
  }
});

test("no active submission uploads normally without canceling the published revision", async () => {
  const { deps, calls } = fake({
    "https://token.test/token": [{ body: { access_token: "tok" } }],
    [statusUrl]: [{ body: { publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "0.3.19" }] } } }],
    [uploadUrl]: [{ body: { crxVersion: "0.3.20", uploadState: "SUCCEEDED" } }],
    [publishUrl]: [{ body: { state: "PENDING_REVIEW" } }],
  });
  assert.equal((await uploadToStore(replacement, deps)).state, "PENDING_REVIEW");
  assert.equal(calls.some(c => c.url === cancelUrl), false);
});

test("replacement requires an explicit numeric version and cannot accompany a draft-only upload", async () => {
  const { deps, calls } = fake({});
  for (const opts of [{ ...replacement, publish: false }, { ...replacement, replacePendingVersion: "" }, { ...replacement, replacePendingVersion: "latest" }]) {
    await assert.rejects(uploadToStore(opts, deps), /exact numeric version/);
  }
  assert.equal(calls.length, 0);
});
