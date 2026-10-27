import { quantity } from "../ui/text.ts";
import type { SyncStatus } from "../sync/engine.ts";

type SyncReply = { ok: boolean; status?: SyncStatus; userId?: string; serverId?: string; error?: string };

/** Shared by the extension options page and Android's settings page. Secrets never come back from the background. */
export function setupSyncSettings(): void {
  const fieldset = document.getElementById("sync-settings");
  if (!fieldset) return;
  const get = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const url = get<HTMLInputElement>("sync-url");
  const token = get<HTMLInputElement>("sync-token");
  const summary = get("sync-summary");
  const dot = get("sync-dot");
  const facts = get("sync-facts");
  const details = get<HTMLDetailsElement>("sync-details");
  const feedback = get("sync-feedback");
  const save = get<HTMLButtonElement>("sync-save");
  const test = get<HTMLButtonElement>("sync-test");
  const run = get<HTMLButtonElement>("sync-run");
  const pause = get<HTMLButtonElement>("sync-pause");
  const disconnect = get<HTMLButtonElement>("sync-disconnect");
  let current: SyncStatus | undefined;
  let busy = false;
  let stopped = false;
  let refreshVersion = 0;

  /** 今天的事只说几点，隔天的才带日期：结论行里放不下一整串年月日。 */
  const briefTime = (ts: number): string => {
    const at = new Date(ts);
    return at.toDateString() === new Date().toDateString()
      ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : at.toLocaleDateString("en-US");
  };
  const text = (tag: string, content: string, className = ""): HTMLElement => {
    const el = document.createElement(tag);
    el.textContent = content;
    if (className) el.className = className;
    return el;
  };

  /*
   * 结论行只回答「好着没有」：状态，加上眼下最要紧的那一件事——出错了说错，有记录上不去说几项，
   * 都没有才说上次什么时候同步的。其余的（账号、服务器、设备、逐类原因）只在排查时才看，收在下面。
   */
  const render = (status: SyncStatus, fill = false): void => {
    current = status;
    if (fill) { url.value = status.baseUrl; token.value = ""; }
    token.placeholder = status.tokenSet ? "Configured; leave blank to keep it" : "Token issued by your administrator";
    const state = status.running ? "Syncing…" : status.enabled ? "Sync enabled" : status.tokenSet ? "Sync paused" : "Not connected";
    const uploadable = status.pending - status.blocked;
    const aside = status.error ? text("span", status.error, "aside error")
      : status.blocked > 0 ? text("span", status.blockedMaterials > 0 ? `${quantity(status.blockedMaterials, "reading item")} could not be uploaded` : `${quantity(status.blocked, "record")} could not be uploaded`, "aside warn")
      : !status.tokenSet ? null
      : text("span", [
        uploadable > 0 ? `Pending upload: ${quantity(uploadable, "item")}` : "",
        status.lastSuccess ? `Last sync: ${briefTime(status.lastSuccess)}` : "Not synced yet",
      ].filter(Boolean).join(" · "), "aside");
    summary.replaceChildren(text("strong", state), ...(aside ? [document.createTextNode(" · "), aside] : []));
    dot.dataset.tone = status.error ? "error" : status.blocked > 0 ? "warn" : status.running ? "busy" : status.enabled ? "ok" : "";

    const rows: [string, HTMLElement][] = [];
    const row = (label: string, value: string, className = ""): void => { rows.push([label, text("dd", value, className)]); };
    if (status.error) row("Error", status.error, "error");
    if (status.tokenSet) {
      row("Last successful sync", status.lastSuccess ? new Date(status.lastSuccess).toLocaleString("en-US") : "Not synced yet");
      row("Pending upload", uploadable > 0 ? `${quantity(uploadable, "item")}; upload will resume on the next sync` : "None");
    }
    if (status.blocked > 0) {
      // 其余记录照常同步，所以这不算「同步失败」；但这几条一直上不去，得让人看见是哪类、为什么
      const dd = text("dd", "", "warn");
      const list = document.createElement("ul");
      for (const reason of status.blockedReasons) list.append(text("li", reason));
      const scope = status.blockedMaterials > 0 ? `${quantity(status.blockedMaterials, "reading item")} (including ${quantity(status.blocked, "record")})` : `${quantity(status.blocked, "record")}`;
      dd.append(`${scope} failed validation and remain on this device: `, list, text("span", "Other records sync normally. Open the article's details on the dashboard to inspect its records.", "note"));
      rows.push(["Could not upload", dd]);
    }
    if (status.userId) {
      row("Account", status.userId, "mono");
      row("Server", status.serverId ?? "—", "mono");
    }
    row("This device", status.deviceId, "mono");
    facts.replaceChildren(...rows.flatMap(([label, dd]) => [text("dt", label), dd]));

    save.textContent = status.enabled ? "Save connection" : "Save and enable sync";
    pause.hidden = !status.enabled;
    disconnect.hidden = !status.tokenSet;
    for (const button of [save, test, pause, disconnect]) button.disabled = busy;
    run.disabled = busy || !status.enabled || status.running;
    url.disabled = busy;
    token.disabled = busy;
  };

  const refresh = async (fill = false): Promise<void> => {
    const version = ++refreshVersion;
    const reply = await chrome.runtime.sendMessage({ type: "sync:get" }) as SyncStatus | SyncReply | undefined;
    if (version !== refreshVersion || stopped) return;
    // 后台出错时回的是 {ok:false,error}；把原因带出来，别让所有故障都长成同一句话。
    if (!reply || !("enabled" in reply) || typeof reply.enabled !== "boolean") {
      const reason = reply && "error" in reply && reply.error ? `: ${reply.error}` : "";
      throw new Error(`Could not load sync settings. Reopen settings and try again.${reason}`);
    }
    render(reply, fill);
  };

  const connection = (): { baseUrl: string; token?: string } => {
    const baseUrl = url.value.trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("Enter your sync server URL");
    // Do not silently send an existing token to a newly entered endpoint, including during a test.
    const changed = baseUrl !== current?.baseUrl.replace(/\/+$/, "");
    const value = token.value.trim();
    if (changed && !value) throw new Error("Re-enter your token when changing the server URL");
    if (!value && !current?.tokenSet) throw new Error("Enter the token issued by your administrator");
    return { baseUrl, ...(value ? { token: value } : {}) };
  };

  const action = async (message: Record<string, unknown>, pending: string, done: string, fill = false): Promise<void> => {
    if (busy) return;
    busy = true;
    ++refreshVersion;
    if (current) render(current);
    feedback.classList.remove("error");
    feedback.textContent = pending;
    try {
      const reply = await chrome.runtime.sendMessage(message) as SyncReply;
      if (!reply?.ok) throw new Error(reply?.error || "The server returned an invalid response");
      if (message.type === "sync:run" && reply.status?.error) throw new Error(reply.status.error);
      feedback.textContent = done + (message.type === "sync:test" && reply.userId
        ? ` · Account: ${reply.userId} · Server: ${reply.serverId ?? "—"}` : "");
      await refresh(fill);
    } catch (error) {
      feedback.classList.add("error");
      feedback.textContent = error instanceof Error ? error.message : String(error);
      try { await refresh(); } catch { /* Keep the actionable error from this request. */ }
    } finally {
      busy = false;
      if (current) render(current);
    }
  };

  const configure = (type: "sync:test" | "sync:configure"): void => {
    try {
      const config = connection();
      void action({ type, ...config, ...(type === "sync:configure" ? { enabled: true } : {}) },
        type === "sync:test" ? "Testing connection…" : "Verifying and saving connection…",
        type === "sync:test" ? "Connection successful. Settings have not been changed." : "Saved. Sync is enabled.", type === "sync:configure");
    } catch (error) {
      feedback.classList.add("error");
      feedback.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  test.addEventListener("click", () => configure("sync:test"));
  save.addEventListener("click", () => configure("sync:configure"));
  run.addEventListener("click", () => void action({ type: "sync:run" }, "Syncing…", "Sync request completed"));
  pause.addEventListener("click", () => {
    if (current) void action({ type: "sync:configure", baseUrl: current.baseUrl, enabled: false }, "Pausing…", "Sync paused. Records are still saved on this device.");
  });
  disconnect.addEventListener("click", () => void action({ type: "sync:disconnect" }, "Disconnecting…", "Disconnected. Records on this device were kept.", true));

  // 展开与否记在这台设备上：排查同步的人会反复刷新这一页，不该每次都重新点开
  const OPEN_KEY = "fs:sync-details-open";
  try { details.open = localStorage.getItem(OPEN_KEY) === "1"; } catch { /* 存不了就每次都收着 */ }
  details.addEventListener("toggle", () => {
    try { localStorage.setItem(OPEN_KEY, details.open ? "1" : "0"); } catch { /* 同上 */ }
  });

  void refresh(true).catch(error => {
    summary.textContent = error instanceof Error ? error.message : String(error);
    dot.dataset.tone = "error";
  });
  const timer = setInterval(() => {
    if (!busy && !document.hidden) void refresh().catch(() => { /* A later refresh or an explicit operation can retry. */ });
  }, 5_000);
  window.addEventListener("pagehide", () => { stopped = true; clearInterval(timer); }, { once: true });
}

setupSyncSettings();
