import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { autoUpdate, checkForUpdate } from "../src/app/update.ts";

const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
let values: Map<string, string>, requests: number;
let armed: string;
let installedVersion: string;
beforeEach(() => {
  installedVersion = "0.3.20";
  requests = 0; armed = "0.3.21"; values = new Map([["fs:update:install", "off"]]);
  g.localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  g.window = { Native: { version: () => installedVersion, updateReady: () => "0.3.21", updateDownload() {}, updateInstall() {},
    updateArm(version: string) { armed = version; }, isDebugBuild: () => false, isMetered: () => false, canSilentUpdate: () => false, updateFailure: () => "" } };
  globalThis.fetch = async () => { requests++; return Response.json({ tag_name: "v0.3.22", assets: [
    { name: "lectern-v0.3.22.apk", browser_download_url: "https://github.com/example/lectern-v0.3.22.apk", size: 1 },
  ] }); };
});

test("preview installations check the releases feed and cache the next preview offer", async () => {
  installedVersion = "0.3.30-preview.30";
  globalThis.fetch = async (url) => {
    requests++;
    assert.equal(String(url), "https://api.github.com/repos/xbghc/lectern/releases?per_page=100");
    return Response.json([{ tag_name: "v0.3.30-preview.31", prerelease: true, assets: [
      { name: "lectern-v0.3.30-preview.31.apk", browser_download_url: "https://github.com/xbghc/lectern/releases/download/v0.3.30-preview.31/lectern-v0.3.30-preview.31.apk", size: 1 },
    ] }]);
  };
  for (let i = 0; i < 2; i++) {
    const step = await autoUpdate();
    assert.ok(step?.do === "offer" && step.update.version === "0.3.30-preview.31");
  }
  assert.equal(requests, 1);
});

test("stable installations still check only the latest stable release", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://api.github.com/repos/xbghc/lectern/releases/latest");
    return Response.json({ tag_name: "v0.3.21", assets: [
      { name: "lectern-v0.3.21.apk", browser_download_url: "https://github.com/xbghc/lectern/releases/download/v0.3.21/lectern-v0.3.21.apk", size: 1 },
    ] });
  };
  assert.equal((await checkForUpdate())?.version, "0.3.21");
});
afterEach(() => {
  for (const key of ["window", "localStorage"] as const) {
    if (saved[key] === undefined) delete g[key]; else g[key] = saved[key];
  }
  globalThis.fetch = saved.fetch;
});

test("a downloaded older APK still checks for newer releases once a day and remembers the newer offer", async () => {
  for (let i = 0; i < 2; i++) {
    const step = await autoUpdate();
    assert.equal(step?.do, "offer");
    assert.ok(step?.do === "offer" && step.update.version === "0.3.22");
  }
  assert.equal(requests, 1);
  assert.equal(armed, "", "an outdated APK cannot stay armed while a newer update is offered");
});

test("offline or disabled update checks still offer an already downloaded APK", async () => {
  globalThis.fetch = async () => { requests++; throw new Error("offline"); };
  assert.deepEqual(await autoUpdate(), { do: "ready", version: "0.3.21", silent: false });
  assert.equal(requests, 1);
  values.set("fs:update:auto", "off");
  assert.deepEqual(await autoUpdate(), { do: "ready", version: "0.3.21", silent: false });
  assert.equal(requests, 1);
});

