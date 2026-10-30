import "./sync.ts";
import { resolveReadingSettings } from "../features/reading/settings.ts";
import type { ExportBundle, ImportOutcome, LlmConfig, LlmLogBundle, LlmUsage, Settings } from "../types.ts";
import { DEFAULT_LLM, DEFAULT_SETTINGS, MAX_AUTO_WORDS } from "../types.ts";
import { saveTextFile } from "../lib/download.ts";
import { SOURCE_LABEL, appLogLine, timingLine } from "../lib/llmStats.ts";
import { summarizeUiUsage } from "../lib/uiUsage.ts";
import { followStoredList } from "../lib/ruleChat.ts";
import { ruleChatBox } from "../popup/ruleChat.ts";
import { setupProviderPicker } from "./providerPicker.ts";
import { normalizeLlmBaseUrl, sameLlmOrigin } from "../lib/llmUrl.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const fields = {
  idle: $<HTMLInputElement>("idle"),
  stall: $<HTMLInputElement>("stall"),
  maxQuiet: $<HTMLInputElement>("maxQuiet"),
  minSession: $<HTMLInputElement>("minSession"),
  dwell: $<HTMLInputElement>("dwell"),
  readFraction: $<HTMLInputElement>("readFraction"),
  episodeGap: $<HTMLInputElement>("episodeGap"),
  excluded: $<HTMLTextAreaElement>("excluded"),
  translationAllowed: $<HTMLTextAreaElement>("translationAllowed"),
  translateEnabled: $<HTMLInputElement>("translateEnabled"),
  restorePositionEnabled: $<HTMLInputElement>("restorePositionEnabled"),
  articleReviewEnabled: $<HTMLInputElement>("articleReviewEnabled"),
  focusBarEnabled: $<HTMLInputElement>("focusBarEnabled"),
  minSel: $<HTMLInputElement>("minSel"),
  maxAuto: $<HTMLInputElement>("maxAuto"),
  ctxChars: $<HTMLInputElement>("ctxChars"),
  explainVocab: $<HTMLInputElement>("explainVocab"),
  finishRatio: $<HTMLInputElement>("finishRatio"),
};
const llmFields = {
  apiKey: $<HTMLInputElement>("apiKey"),
  model: $<HTMLInputElement>("model"),
  baseUrl: $<HTMLInputElement>("baseUrl"),
  protocol: $<HTMLSelectElement>("protocol"),
  maxTokens: $<HTMLInputElement>("maxTokens"),
  timeout: $<HTMLInputElement>("timeout"),
};
const status = $("status");
const dataStatus = $("data-status");

function fill(s: Settings): void {
  s = { ...s, ...resolveReadingSettings(s) };
  fields.idle.value = String(Math.round(s.idleTimeoutMs / 1000));
  fields.stall.value = String(Math.round(s.stallTimeoutMs / 1000));
  fields.maxQuiet.value = String(Math.round(s.maxQuietMs / 1000));
  fields.minSession.value = String(Math.round(s.minSessionMs / 1000));
  fields.dwell.value = String(s.paragraphDwellMs);
  fields.readFraction.value = String(Math.round(s.readFraction * 100));
  fields.episodeGap.value = String(Math.round(s.episodeGapMs / 60_000));
  fields.excluded.value = s.articleExcludedUrls.join("\n");
  fields.translationAllowed.value = s.translationAllowedUrls.join("\n");
  fields.translateEnabled.checked = s.translateEnabled;
  fields.restorePositionEnabled.checked = s.restorePositionEnabled;
  fields.articleReviewEnabled.checked = s.articleReviewEnabled;
  fields.focusBarEnabled.checked = s.focusBarEnabled;
  fields.minSel.value = String(s.minSelectionChars);
  fields.maxAuto.value = String(s.maxAutoSelectionWords);
  fields.ctxChars.value = String(s.contextChars);
  fields.explainVocab.checked = s.explainVocab;
  fields.finishRatio.value = String(Math.round(s.finishRatio * 100));
}

/** 读表单并夹到合法区间；非法输入退回默认值而不是写入 NaN。 */
function collect(): Settings {
  const num = (input: HTMLInputElement, fallback: number, min: number, max: number): number => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  };
  const collected: Settings = {
    idleTimeoutMs: num(fields.idle, 30, 5, 600) * 1000,
    stallTimeoutMs: num(fields.stall, 90, 10, 1800) * 1000,
    maxQuietMs: num(fields.maxQuiet, 300, 0, 1800) * 1000,
    minSessionMs: num(fields.minSession, 3, 0, 120) * 1000,
    paragraphDwellMs: num(fields.dwell, 1000, 100, 10_000),
    readFraction: num(fields.readFraction, 50, 10, 100) / 100,
    episodeGapMs: num(fields.episodeGap, 5, 0, 120) * 60_000,
    excludedDomains: [],
    translationAllowedUrls: fields.translationAllowed.value.split("\n").map(line => line.trim()).filter(Boolean),
    articleExcludedUrls: fields.excluded.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    translateEnabled: fields.translateEnabled.checked,
    restorePositionEnabled: fields.restorePositionEnabled.checked,
    articleReviewEnabled: fields.articleReviewEnabled.checked,
    focusBarEnabled: fields.focusBarEnabled.checked,
    minSelectionChars: num(fields.minSel, 2, 1, 20),
    maxAutoSelectionWords: num(fields.maxAuto, DEFAULT_SETTINGS.maxAutoSelectionWords, 3, MAX_AUTO_WORDS),
    contextChars: num(fields.ctxChars, 600, 0, 2000),
    explainVocab: fields.explainVocab.checked,
    finishRatio: num(fields.finishRatio, 80, 10, 100) / 100,
  };
  return { ...collected, ...resolveReadingSettings(collected) };
}

/*
 * 「保存」统一保存阅读偏好和模型配置；设备同步仍由独立的连接操作管理。
 * baseline 是上次读到或存下的值，经 collect() 走一遍再记——和表单比的时候两边是同一种夹法，
 * 不会因为毫秒和秒来回取整就平白显示「有修改」。
 */
const saveBar = $("savebar");
const revertBtn = $<HTMLButtonElement>("revert");
let baseline: Settings | null = null;
let llmBaseline: Record<string, string> | null = null;
let savedLlm: (LlmConfig & { apiKeySet?: boolean }) | null = null;
let saving = false;
let testing = false;
let flashing: { msg: string; error: boolean } | null = null;
let statusTimer: number | null = null;

function changedCount(): number {
  if (!baseline) return 0;
  const now = collect();
  const base = baseline;
  return (Object.keys(now) as (keyof Settings)[]).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(base[k])).length + llmChangedCount();
}

function llmDraft(): Record<string, string> {
  return { provider: picker.provider(), ...Object.fromEntries(Object.entries(llmFields).map(([key, input]) => [key, input.value.trim()])) };
}
function llmChangedCount(): number {
  if (!llmBaseline) return 0;
  const draft = llmDraft();
  return Object.keys(draft).filter(key => draft[key] !== llmBaseline![key]).length;
}

/** App 的设置页要在离开前问一声（见 app/options.ts）：WebView 不弹 beforeunload 的框。 */
export const hasUnsavedChanges = (): boolean => changedCount() > 0;

/** 状态栏一处两用：刚发生的事（存好了、填错了）优先，没有就报还有几项没保存。 */
function renderStatus(): void {
  const changed = changedCount();
  saveBar.hidden = changed === 0 && !saving && !flashing;
  saveBar.classList.toggle("is-dirty", changed > 0);
  revertBtn.hidden = changed === 0;
  status.classList.toggle("error", flashing?.error ?? false);
  status.textContent = flashing ? flashing.msg : changed > 0 ? `${changed} unsaved changes` : "";
  $<HTMLButtonElement>("save").disabled = saving || testing || !baseline || !llmBaseline || changed === 0;
  revertBtn.disabled = saving || testing;
  $<HTMLButtonElement>("reset").disabled = saving || testing;
  const test = $<HTMLButtonElement>("test-llm");
  test.disabled = saving || testing || !baseline || !llmBaseline;
  test.textContent = testing ? "Testing connection…" : saving ? "Saving…" : changed > 0 ? "Save changes and test" : "Test connection";
  test.title = changed > 0 ? "Save all changes, then test the model connection" : "Test the saved model connection";
  $("consent-agree").textContent = changed > 0 ? "Save changes and agree" : "Agree and start";
  $("model-save-state").textContent = llmChangedCount() > 0 ? "Model changes have not been saved." : savedLlm?.provider ? "Model settings saved on this device." : "";
}

function flash(msg: string, error = false): void {
  flashing = { msg, error };
  if (statusTimer !== null) window.clearTimeout(statusTimer);
  // 报错多留一会儿：它往往要人滚回去改
  statusTimer = window.setTimeout(() => {
    flashing = null;
    renderStatus();
  }, error ? 6000 : 2500);
  renderStatus();
}

/** stall 和 idle 是一对，错也是一对的错：两个框一起标红，气泡挂在要改大的那个上。 */
function markThresholds(error: string): void {
  fields.stall.setCustomValidity(error);
  for (const input of [fields.idle, fields.stall]) {
    if (error) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }
}

function load(s: Settings): void {
  fill(s);
  baseline = collect();
  renderStatus();
}

for (const input of Object.values(fields)) {
  input.addEventListener("input", () => {
    markThresholds("");
    renderStatus();
  });
}

// 标签页一关，没保存的修改就没了，而且没有任何动静——问一声
window.addEventListener("beforeunload", (e) => {
  if (changedCount() === 0) return;
  e.preventDefault();
  // Chrome 119 之前只认 returnValue
  e.returnValue = true;
});

async function saveChanges(): Promise<boolean> {
  if (saving || testing || !baseline || !llmBaseline) return false;
  const next = collect();
  if (next.stallTimeoutMs <= next.idleTimeoutMs) {
    const msg = "The stall timeout must be longer than the idle timeout.";
    // 保存条可能离这两个框一千多像素：把错报在框上，浏览器会自己滚过去
    markThresholds(msg);
    fields.stall.reportValidity();
    flash(msg, true);
    return false;
  }
  let model: Partial<LlmConfig> | null = null;
  try { if (llmChangedCount() > 0) model = collectLlm(); }
  catch (err) {
    const message = err instanceof Error ? err.message : "Check the model settings.";
    llmStatus.textContent = message;
    flash(message, true);
    const section = llmFields.apiKey.closest("details");
    if (section) section.open = true;
    return false;
  }
  saving = true;
  const modelSection = llmFields.apiKey.closest("fieldset")!;
  const preferenceControls = Object.values(fields).map(input => ({ input, disabled: input.disabled }));
  for (const { input } of preferenceControls) input.disabled = true;
  modelSection.disabled = true;
  renderStatus();
  try {
    if (model) await saveLlm(model);
    const result = await chrome.runtime.sendMessage({ type: "settings:set", settings: next });
    if (result?.ok === false) throw new Error(result.error ?? "Unknown error");
    load(next);
    flash("Saved. Changes apply to open pages immediately.");
    return true;
  } catch (err) {
    const message = `Could not save: ${err instanceof Error ? err.message : "Unknown error"}`;
    if (model) llmStatus.textContent = message;
    flash(message, true);
    return false;
  } finally {
    saving = false;
    modelSection.disabled = false;
    for (const { input, disabled } of preferenceControls) input.disabled = disabled;
    renderStatus();
  }
}
$("save").addEventListener("click", () => void saveChanges());

/*
 * 「用一句话改名单」。确认之后写进去的是存储里的名单；这里的两个名单框和「上次保存的值」跟着改。
 * 框里有没保存的手改，就在手改上套同样的改动——不冲掉，也不替人按保存。
 */
const lines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);
$("rule-chat").append(ruleChatBox({
  placeholder: "For example: stop tracking Reddit and X; enable translation on GitHub",
  onApplied: async (applied) => {
    const stored = (await chrome.runtime.sendMessage({ type: "settings:get" })) as Settings;
    const boxes = [["articleExcludedUrls", fields.excluded], ["translationAllowedUrls", fields.translationAllowed]] as const;
    for (const [key, box] of boxes) {
      const mine = applied.filter((c) => c.list === key);
      if (mine.length === 0) continue;
      box.value = followStoredList(lines(box.value), baseline?.[key], stored[key], mine).join("\n");
      if (baseline) baseline = { ...baseline, [key]: stored[key] };
    }
    renderStatus();
  },
}));

revertBtn.addEventListener("click", () => {
  if (!baseline) return;
  markThresholds("");
  if (savedLlm) fillLlm(savedLlm);
  load(baseline);
  flash("Restored the last saved settings");
});

$("reset").addEventListener("click", () => {
  // 两份名单是用户自己攒的数据，不是「参数」：恢复默认只动开关和阈值，不把名单清空
  const kept = collect();
  fill({
    ...DEFAULT_SETTINGS,
    articleExcludedUrls: kept.articleExcludedUrls,
    translationAllowedUrls: kept.translationAllowedUrls,
  });
  markThresholds("");
  flash(changedCount() > 0 ? "Defaults restored; lists were kept. Save to apply." : "Already using the defaults");
});

$("export").addEventListener("click", async () => {
  const bundle = (await chrome.runtime.sendMessage({ type: "data:export" })) as ExportBundle;
  // 用 <a download> 而不是 downloads API，省掉一个权限声明；安卓里由宿主接管，见 lib/download.ts
  const note = saveTextFile(
    `lectern-${new Date().toISOString().slice(0, 10)}.json`,
    "application/json",
    JSON.stringify(bundle, null, 2),
    $<HTMLAnchorElement>("download"),
  );
  dataStatus.textContent = `Exported ${bundle.sessions.length} sessions / ${bundle.articles.length} articles${note ? ", " + note : ""}`;
});

$("import").addEventListener("click", () => $<HTMLInputElement>("import-file").click());
$<HTMLInputElement>("import-file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  dataStatus.textContent = "Merging…";
  try {
    const raw: unknown = JSON.parse(await file.text());
    const res = (await chrome.runtime.sendMessage({ type: "data:import", bundle: raw })) as ImportOutcome;
    dataStatus.textContent = res.ok ? res.message : `Import failed: ${res.error}`;
  } catch (err) {
    dataStatus.textContent = `Could not load: ${err instanceof Error ? err.message : String(err)}`;
  }
  // 清掉选择，同一个文件才能再选一次
  input.value = "";
});

const clearButton = $<HTMLButtonElement>("clear");
clearButton.addEventListener("click", async () => {
  if (clearButton.disabled) return;
  if (!confirm("Clear reading records and offline articles on this device and disconnect sync? Server data and other devices will not be affected. Settings and model credentials will be kept. Export any data you want to keep first.")) return;
  clearButton.disabled = true;
  dataStatus.classList.remove("error");
  dataStatus.textContent = "Clearing…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "data:clear" }) as { ok?: boolean; error?: string } | undefined;
    if (!result?.ok) throw new Error(result?.error || "The app did not confirm that records were cleared. Try again.");
    dataStatus.textContent = "Cleared";
  } catch (error) {
    dataStatus.classList.add("error");
    dataStatus.textContent = `Could not clear: ${error instanceof Error ? error.message : String(error)}`;
  } finally { clearButton.disabled = false; }
});

void chrome.runtime.sendMessage({ type: "settings:get" }).then((s: Settings) => load(s ?? DEFAULT_SETTINGS));

/* ==================== 模型服务 ==================== */

const picker = setupProviderPicker({
  search: $<HTMLInputElement>("provider-search"),
  list: $<HTMLSelectElement>("provider"),
  protocol: llmFields.protocol,
  baseUrl: llmFields.baseUrl,
  model: llmFields.model,
  models: $<HTMLDataListElement>("model-list"),
  doc: $<HTMLAnchorElement>("provider-doc"),
});
/** 保存时的地址与密钥状态；协议、主机或有效端口变化都不能沿用原 Key。 */
let saved = { baseUrl: "", apiKeySet: false };

const llmStatus = $("llm-status");
// 上一次保存留下的提示（「先选一家」之类）在人动手改了之后就过时了
$("provider").addEventListener("change", () => {
  $<HTMLDetailsElement>("model-advanced").open = picker.provider() === "custom";
  llmStatus.textContent = ""; renderStatus();
});
for (const input of Object.values(llmFields)) {
  for (const event of ["input", "change"]) input.addEventListener(event, () => { llmStatus.textContent = ""; renderStatus(); });
}

/*
 * 同意把内容发给模型服务。没同意之前后台一个请求都不发（lib/llm.ts 的 assertReady），
 * 所以这里只管把那一个时间戳写进去或清掉，不用通知别的地方。
 */
let consented = false;
function fillConsent(at: number | null): void {
  consented = at !== null;
  $("consent").hidden = consented;
  $("consent-state").hidden = !consented;
  if (at !== null) $("consent-date").textContent = new Date(at).toLocaleDateString("en-US");
}
async function setConsent(at: number | null): Promise<void> {
  const action = at === null ? "withdraw consent" : "save consent";
  try {
    const result = await chrome.runtime.sendMessage({ type: "llm:set", config: { consentAt: at } }) as { ok?: boolean; error?: string };
    if (!result?.ok) {
      llmStatus.textContent = `Could not ${action}: ${result?.error ?? "Unknown error"}`;
      return;
    }
  } catch (err) {
    llmStatus.textContent = `Could not ${action}: ${err instanceof Error ? err.message : "Unknown error"}`;
    return;
  }
  // 只在持久化成功后更新同意状态；不重载其它未保存的表单内容。
  fillConsent(at);
  if (savedLlm) savedLlm = { ...savedLlm, consentAt: at };
  llmStatus.textContent = "";
}
$("consent-agree").addEventListener("click", async () => {
  // Consent applies to the provider shown in this form, not a previously saved connection.
  if (hasUnsavedChanges() && !await saveChanges()) return;
  await setConsent(Date.now());
});
$("consent-revoke").addEventListener("click", () => void setConsent(null));

function fillLlm(cfg: LlmConfig & { apiKeySet?: boolean }): void {
  fillConsent(cfg.consentAt ?? null);
  // 密钥不回显：后台只回传"设没设过"。留空提交表示保持不变。
  llmFields.apiKey.value = "";
  llmFields.apiKey.placeholder = cfg.apiKeySet ? "Configured; leave blank to keep it" : "Not configured";
  picker.show(cfg);
  $<HTMLDetailsElement>("model-advanced").open = cfg.provider === "custom";
  saved = { baseUrl: cfg.baseUrl, apiKeySet: !!cfg.apiKeySet };
  llmFields.maxTokens.value = String(cfg.maxTokens);
  llmFields.timeout.value = String(Math.round(cfg.timeoutMs / 1000));
  savedLlm = cfg;
  llmBaseline = llmDraft();
  renderStatus();
}

function clamp(input: HTMLInputElement, fallback: number, min: number, max: number): number {
  const v = Number(input.value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function collectLlm(): Partial<LlmConfig> {
  let baseUrl: string;
  const model = llmFields.model.value.trim();
  const key = llmFields.apiKey.value.trim();
  // 这几样缺了哪样请求都发不出去，存下来只会换成一条更晚、更绕的报错
  if (!picker.provider()) throw new Error("Choose a provider above, or select Custom endpoint.");
  try {
    baseUrl = normalizeLlmBaseUrl(llmFields.baseUrl.value);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "Enter a valid base URL.");
  }
  if (!model) throw new Error("Choose a model or enter its name from your provider's documentation.");
  // 后台也会清掉旧密钥（见 setLlmConfig），这里先拦下说明白，免得人以为是保存坏了
  if (saved.apiKeySet && !key && !sameLlmOrigin(baseUrl, saved.baseUrl)) {
    throw new Error("The endpoint changed. Enter an API key for this provider; the previous key will not be sent to the new endpoint.");
  }
  const patch: Partial<LlmConfig> = {
    provider: picker.provider(),
    protocol: llmFields.protocol.value === "anthropic" ? "anthropic" : "openai",
    baseUrl,
    model,
    maxTokens: clamp(llmFields.maxTokens, DEFAULT_LLM.maxTokens, 256, 8192),
    timeoutMs: clamp(llmFields.timeout, DEFAULT_LLM.timeoutMs / 1000, 5, 120) * 1000,
  };
  if (key) patch.apiKey = key;
  return patch;
}

async function saveLlm(patch: Partial<LlmConfig>): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: "llm:set", config: patch }) as { ok?: boolean; error?: string };
  if (!result?.ok) throw new Error(result?.error ?? "Unknown error");
  await loadLlm();
  llmStatus.textContent = consented ? "Model settings saved." : "Saved. Review the sharing notice in this section before testing the connection.";
}

$("test-llm").addEventListener("click", async () => {
  if (saving || testing) return;
  if (hasUnsavedChanges() && !await saveChanges()) return;
  // 测试连接也是一次请求：没同意过就不发，说清楚卡在哪儿
  if (!consented) {
    llmStatus.textContent = "Your settings are saved. Review the sharing notice and select Agree and start before testing.";
    $("consent-agree").focus();
    return;
  }
  testing = true;
  const modelSection = llmFields.apiKey.closest("fieldset")!;
  modelSection.disabled = true;
  renderStatus();
  llmStatus.textContent = "Testing saved connection…";
  try {
    const res = (await chrome.runtime.sendMessage({ type: "llm:test" })) as {
    ok: boolean;
    error?: string;
    model?: string;
  };
    llmStatus.textContent = res.ok ? `Connected (${res.model})` : `Connection failed: ${res.error ?? "Unknown error"}`;
  } catch (err) {
    llmStatus.textContent = `Connection failed: ${err instanceof Error ? err.message : "Unknown error"}`;
  } finally { testing = false; modelSection.disabled = false; renderStatus(); }
});

async function loadLlm(): Promise<void> {
  const cfg = (await chrome.runtime.sendMessage({ type: "llm:get" })) as LlmConfig & { apiKeySet: boolean };
  fillLlm(cfg ?? { ...DEFAULT_LLM, apiKeySet: false });
  const u = (await chrome.runtime.sendMessage({ type: "llm:usage" })) as LlmUsage;
  $("usage").textContent = u.requests
    ? `Total: ${u.requests} requests (failed: ${u.errors}), input: ${u.inputTokens} tokens, output: ${u.outputTokens} tokens.`
    : "No model requests yet.";
}

void loadLlm();

/* ==================== 诊断日志 ==================== */

const logStatus = $("log-status");
const logSummary = $("log-summary");
const logTiming = $("log-timing");
const logApp = $("log-app");

/** 提示里报的条数。六份都要数：只报失败的话，用户不知道翻译轨迹（带选中的文本）和抓取记录也一起带出去了。 */
const counts = (b: LlmLogBundle): string =>
  `${b.failures.length} failures + ${b.timings.length} timings + ${b.translations.length} translation traces + ${b.fetches.length} fetches + ${b.errors.length} errors + ${Object.keys(b.usage.days).length} days of interaction counts`;
/** App 的设置页也要用它（分享日志），所以导出。 */
export async function fetchLog(): Promise<LlmLogBundle> {
  return (await chrome.runtime.sendMessage({ type: "llm:log" })) as LlmLogBundle;
}

async function loadLog(): Promise<void> {
  const bundle = await fetchLog();
  const last = bundle.failures.at(-1);
  logSummary.textContent = last
    ? `${bundle.failures.length} failures; latest: ${new Date(last.ts).toLocaleString("en-US")}, ${SOURCE_LABEL[last.source]}: ${last.message.slice(0, 120)}`
    : "No failures recorded.";
  logTiming.textContent = timingLine(bundle.timings);
  logApp.textContent = appLogLine(bundle.fetches, bundle.errors);
  renderUsage(bundle);
}

/**
 * 按钮计数。表里的每个按钮都有一行，一次没点过的也列——要找的正是那些零。
 * 结论行先说统计了多久：装上才三天的话满屏的零什么都说明不了。
 */
function renderUsage(bundle: LlmLogBundle): void {
  const usage = summarizeUiUsage(bundle.usage, Date.now());
  const unused = usage.rows.filter((row) => row.total === 0).length;
  $("usage-summary").textContent = usage.since
    ? `Dashboard interactions: since ${usage.since}, ${usage.activeDays} active days; ${usage.rows.length} actions, ${unused} never used`
    : "No dashboard interactions recorded yet.";
  const body = $("usage-rows");
  body.textContent = "";
  for (const row of usage.rows) {
    const tr = document.createElement("tr");
    if (row.total === 0) tr.className = "never";
    for (const text of [row.label, row.last7, row.last30, row.total]) {
      const td = document.createElement("td");
      td.textContent = String(text);
      tr.append(td);
    }
    body.append(tr);
  }
}

$("log-copy").addEventListener("click", async () => {
  const bundle = await fetchLog();
  // 点击是用户手势，剪贴板写入不需要额外权限
  try {
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    logStatus.textContent = `Copied ${counts(bundle)} to the clipboard`;
  } catch {
    logStatus.textContent = "Could not copy. Try downloading instead.";
  }
});

$("log-download").addEventListener("click", async () => {
  const bundle = await fetchLog();
  // 与数据导出同一套：<a download> 而不是 downloads API，省掉一个权限声明
  const note = saveTextFile(
    `lectern-llm-log-${new Date().toISOString().slice(0, 10)}.json`,
    "application/json",
    JSON.stringify(bundle, null, 2),
    $<HTMLAnchorElement>("log-file"),
  );
  logStatus.textContent = `Downloaded ${counts(bundle)}${note ? ", " + note : ""}`;
});

$("log-clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "llm:log-clear" });
  logStatus.textContent = "Cleared";
  await loadLog();
});

void loadLog();
