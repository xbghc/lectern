import { localStorage } from "../../sync/storage.ts";
import type { LlmConfig, LlmProviderConfig, LlmProviderStats, LlmUsage, PublicLlmProviderConfig } from "../../types.ts";
import { DEFAULT_LLM, EMPTY_USAGE, LEGACY_MINIMAX } from "../../types.ts";
import { serialize, updateLocalOnly } from "../../background/store.ts";
import { normalizeLlmBaseUrl, sameLlmOrigin } from "../../lib/llmUrl.ts";
import { findProvider } from "../../lib/providers.ts";

/**
 * 模型连接的配置与用量。文章判别、文章回顾、划词翻译共用一份，不属于任何一个功能。
 *
 * 写操作走 store.ts 那条串行队列——service worker 会并发处理多个标签页的消息。
 */

export const KEY_LLM = "llm";
export const KEY_USAGE = "llmUsage";

const local = (): chrome.storage.StorageArea => localStorage();

/**
 * 单独一个 key，**绝不并进 Settings**。
 * content script 启动时会把整个 settings 对象读进页面上下文，而 content script
 * 与网页共享同一个渲染进程——API key 出现在那里等于交给了页面上的任意脚本。
 */
export async function getLlmConfig(): Promise<LlmConfig> {
  const got = await local().get(KEY_LLM);
  const stored = (got[KEY_LLM] as StoredLlm) ?? {};
  // 多提供商之前存下的配置没有 provider 这个键。那时只有 MiniMax 一家，地址和模型名靠默认值补；
  // 现在的默认是「什么都没选」，所以这种旧配置要按当时的默认补，老用户升级后才不会突然停摆。
  // 那时也能手改 Base URL：改成了别家的，标签就不该还叫 MiniMax。
  const legacy = stored.provider === undefined && Object.keys(stored).length > 0;
  const merged = { ...DEFAULT_LLM, ...(legacy ? LEGACY_MINIMAX : {}), ...stored, ...raiseBudget(stored) };
  if (legacy && !/minimax/i.test(merged.baseUrl)) merged.provider = "custom";
  // 旧配置不在读取时覆写；坏地址留给设置页修复，实际请求仍会严格拒绝。
  if (merged.baseUrl) {
    try { merged.baseUrl = normalizeLlmBaseUrl(merged.baseUrl); } catch { /* 请求前统一校验 */ }
  }
  return merged;
}

type StoredLlm = Partial<LlmConfig> & {
  /** 一次性标记：输出上限与超时的默认值那次抬升已经跑过。 */
  budgetRaised?: boolean;
  /** 按 provider id 记住各家存过的连接配置，来回切换时不必重新填写。 */
  providers?: Record<string, LlmProviderConfig>;
};

export type PublicLlmConfig = Omit<LlmConfig, "apiKey"> & {
  apiKey: "";
  apiKeySet: boolean;
  providers: Record<string, PublicLlmProviderConfig>;
};

/** 整理已存的各家配置，并把当前正在用的这一家（若地址合法）一并算进去，兼容尚未落过 providers 表的旧配置。 */
function storedProvidersOf(current: StoredLlm & LlmConfig): Record<string, LlmProviderConfig> {
  const map: Record<string, LlmProviderConfig> = {};
  for (const [id, entry] of Object.entries(current.providers ?? {})) {
    if (!id || !entry || typeof entry !== "object") continue;
    try {
      const baseUrl = normalizeLlmBaseUrl(entry.baseUrl);
      map[id] = {
        protocol: entry.protocol === "anthropic" ? "anthropic" : "openai",
        baseUrl,
        model: typeof entry.model === "string" ? entry.model : "",
        apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "",
      };
    } catch {
      /* 忽略历史无效地址 */
    }
  }
  if (current.provider && current.baseUrl) {
    try {
      const baseUrl = normalizeLlmBaseUrl(current.baseUrl);
      map[current.provider] = {
        protocol: current.protocol,
        baseUrl,
        model: current.model,
        apiKey: current.apiKey,
      };
    } catch {
      /* 当前地址无效时不收入可用配置表 */
    }
  }
  return map;
}

/** 传给设置页/弹窗的配置：不回显任何一家服务的明文密钥，只告知是否已配置。 */
export function redactLlmConfig(cfg: LlmConfig): PublicLlmConfig {
  const stored = storedProvidersOf(cfg as StoredLlm & LlmConfig);
  const providers = Object.fromEntries(
    Object.entries(stored).map(([id, p]) => [
      id,
      {
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        model: p.model,
        apiKeySet: p.apiKey.length > 0,
      },
    ]),
  );
  return {
    ...cfg,
    apiKey: "",
    apiKeySet: cfg.apiKey.length > 0,
    providers,
  };
}

/** 抬升前的两个默认值。 */
const OLD_MAX_TOKENS = 1024;
const OLD_TIMEOUT_MS = 30_000;

/**
 * 把停在旧默认值上的输出上限与超时抬上来。
 *
 * 1024 是照着"只翻一句、没有讲解"定的，讲解上线后就显小了——实测 200 词的选区
 * 要 671 个输出 token，只剩三成余量。而 max_tokens 压低换不来省钱（见 LlmConfig 的说明），
 * 只换来截断，所以没有理由留着。超时一起抬：上限松了而超时没松，
 * 只是把"被截断"换成了"超时"。
 *
 * 和设置里那次阈值抬升同一套做法、同一份代价（当真手填过 1024 的人也会被抬这一次），
 * 见 store.ts 的 raiseAutoWords。这里不必像那边一样主动落盘：
 * LLM 配置只有 background 读，没有绕过这一层的读法。
 */
function raiseBudget(stored: StoredLlm): StoredLlm {
  if (stored.budgetRaised) return {};
  return {
    ...(stored.maxTokens === OLD_MAX_TOKENS ? { maxTokens: DEFAULT_LLM.maxTokens } : {}),
    ...(stored.timeoutMs === OLD_TIMEOUT_MS ? { timeoutMs: DEFAULT_LLM.timeoutMs } : {}),
    budgetRaised: true,
  };
}

export async function setLlmConfig(patch: Partial<LlmConfig>): Promise<LlmConfig> {
  return serialize(async () => {
    const current = (await getLlmConfig()) as StoredLlm & LlmConfig;
    // 独立撤回同意不能被旧的坏地址锁住；夹带其它改动、重新同意仍须完整校验。
    const revokeOnly = patch.consentAt === null && Object.keys(patch).length === 1;
    if (revokeOnly) {
      const revoked = { ...current, consentAt: null };
      await local().set({ [KEY_LLM]: revoked });
      return revoked;
    }

    const providers = storedProvidersOf(current);
    const targetProvider = patch.provider ?? current.provider;
    const switchingProvider = patch.provider !== undefined && patch.provider !== current.provider;
    const remembered = switchingProvider && targetProvider ? providers[targetProvider] : undefined;
    const preset = switchingProvider && !remembered && targetProvider ? findProvider(targetProvider) : undefined;

    const base = switchingProvider
      ? (remembered ?? {
          protocol: preset?.protocol ?? current.protocol,
          baseUrl: preset?.baseUrl ?? "",
          model: "",
          apiKey: "",
        })
      : {
          protocol: current.protocol,
          baseUrl: current.baseUrl,
          model: current.model,
          apiKey: current.apiKey,
        };

    const protocol = patch.protocol ?? base.protocol;
    const model = patch.model ?? base.model;
    let baseUrl = patch.baseUrl ?? base.baseUrl;
    // 空串表示尚未配置；其它地址保存前先校验，失败绝不落盘。
    if (baseUrl !== "") baseUrl = normalizeLlmBaseUrl(baseUrl);

    let apiKey: string;
    if (patch.apiKey !== undefined) {
      const trimmed = patch.apiKey.trim();
      // 回填或再次提交原 Key 不算新 Key。后台兜底，不能依赖某个 UI 是否记得清空输入框。
      const replayedCurrent = !sameLlmOrigin(current.baseUrl, baseUrl) && trimmed === current.apiKey.trim();
      const replayedBase = base.apiKey !== "" && !sameLlmOrigin(base.baseUrl, baseUrl) && trimmed === base.apiKey.trim();
      const validRememberedSameKey = Boolean(remembered && sameLlmOrigin(remembered.baseUrl, baseUrl) && trimmed === remembered.apiKey.trim());
      apiKey = (replayedCurrent || replayedBase) && !validRememberedSameKey ? "" : trimmed;
    } else if (switchingProvider) {
      if (remembered) {
        apiKey = sameLlmOrigin(remembered.baseUrl, baseUrl) ? remembered.apiKey : "";
      } else {
        apiKey = sameLlmOrigin(current.baseUrl, baseUrl) ? current.apiKey : "";
      }
    } else {
      apiKey = patch.baseUrl !== undefined && !sameLlmOrigin(current.baseUrl, baseUrl) ? "" : current.apiKey;
    }

    if (targetProvider && baseUrl !== "") {
      providers[targetProvider] = { protocol, baseUrl, model, apiKey };
    }

    const merged: StoredLlm & LlmConfig = {
      ...current,
      ...patch,
      provider: targetProvider,
      protocol,
      baseUrl,
      model,
      apiKey,
      ...(Object.keys(providers).length > 0 ? { providers } : {}),
    };
    await local().set({ [KEY_LLM]: merged });
    return merged;
  });
}

export async function getUsage(): Promise<LlmUsage> {
  const got = await local().get(KEY_USAGE);
  return { ...EMPTY_USAGE, ...((got[KEY_USAGE] as Partial<LlmUsage>) ?? {}) };
}

export interface UsageCallMeta {
  provider?: string;
  model?: string;
  totalMs?: number;
}

/** 在一份用量上记一次调用。单拎出来是给 llmLog.ts 的 recordCall 用：用量和耗时一笔写完。 */
export function bumpUsage(stored: unknown, input: number, output: number, failed: boolean, meta?: UsageCallMeta): LlmUsage {
  const now = Date.now();
  const u: LlmUsage = { ...EMPTY_USAGE, ...((stored as Partial<LlmUsage> | undefined) ?? {}) };
  const provider = (meta?.provider ?? "").trim();
  const model = (meta?.model ?? "").trim();
  let providers: Record<string, LlmProviderStats> | undefined = u.providers ? { ...u.providers } : undefined;
  if (provider || model) {
    providers ??= {};
    const key = `${provider || "unknown"}::${model || "unknown"}`;
    const prev = providers[key];
    const totalMs = typeof meta?.totalMs === "number" && Number.isFinite(meta.totalMs) && meta.totalMs > 0 ? meta.totalMs : 0;
    const timed = output > 0 && totalMs > 0;
    providers[key] = {
      provider,
      model,
      requests: (prev?.requests ?? 0) + 1,
      errors: (prev?.errors ?? 0) + (failed ? 1 : 0),
      inputTokens: (prev?.inputTokens ?? 0) + input,
      outputTokens: (prev?.outputTokens ?? 0) + output,
      timedCalls: (prev?.timedCalls ?? 0) + (timed ? 1 : 0),
      timedOutputTokens: (prev?.timedOutputTokens ?? 0) + (timed ? output : 0),
      outputMs: (prev?.outputMs ?? 0) + (timed ? totalMs : 0),
      lastTs: now,
    };
  }
  return {
    requests: u.requests + 1,
    inputTokens: u.inputTokens + input,
    outputTokens: u.outputTokens + output,
    errors: u.errors + (failed ? 1 : 0),
    lastTs: now,
    ...(providers ? { providers } : {}),
  };
}

export async function addUsage(input: number, output: number, failed = false, meta?: UsageCallMeta): Promise<void> {
  await updateLocalOnly([KEY_USAGE], (v) => ({ [KEY_USAGE]: bumpUsage(v[KEY_USAGE], input, output, failed, meta) }));
}
