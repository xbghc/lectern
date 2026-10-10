import type { LlmProtocol } from "../types.ts";
import { PROVIDERS } from "./providers.generated.ts";

/**
 * 设置页「选一家模型服务」用的清单。数据是 models.dev 的快照（见 scripts/update-providers.ts），
 * 这里只管怎么排、怎么搜。只有设置页用它——后台发请求看的是存下来的 protocol 和 baseUrl，不查这张表，
 * 所以清单里某家的地址过时了也不会坏事：人把 Base URL 改对就行。
 */
export interface ProviderPreset {
  id: string;
  name: string;
  protocol: LlmProtocol;
  /** 带版本段的接口根地址。 */
  baseUrl: string;
  /** 这家的文档页，没有就是空串。 */
  doc: string;
  /** 较新的几个模型名，给模型输入框当候选；不全，也不保证这把 Key 都能用。 */
  models: readonly string[];
}

/** 自己填地址。不在清单里，选它的时候协议和地址都由人定。 */
export const CUSTOM_PROVIDER = "custom";

/**
 * 没在搜的时候排在最前面的几家：两家协议的本家、几个常用的聚合与国内服务。
 * 清单里要是没有某个 id（models.dev 改了名），它就不出现，别的不受影响。
 */
export const PINNED: readonly string[] = [
  "openai", "anthropic", "google", "deepseek", "openrouter", "minimax-cn", "minimax", "zhipuai", "alibaba-cn", "moonshotai-cn",
];

/** 清单里的名字是英文的。给置顶的几家补上中文叫法，搜「智谱」「通义」也找得到。 */
const ALIASES: Record<string, string> = {
  google: "gemini 谷歌",
  deepseek: "深度求索",
  "minimax-cn": "海螺 国内",
  minimax: "国际",
  zhipuai: "智谱 glm bigmodel",
  "alibaba-cn": "阿里 通义 千问 百炼 qwen dashscope",
  "moonshotai-cn": "月之暗面 kimi",
};

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

export const findProvider = (id: string): ProviderPreset | undefined => byId.get(id);

/** 地址只取域名：路径里常带别家的名字（Google 的兼容端点就以 `/openai` 结尾），整条拿来搜会搜出不相干的。 */
const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
};

const haystack = (p: ProviderPreset): string => `${p.name} ${p.id} ${ALIASES[p.id] ?? ""} ${hostOf(p.baseUrl)}`.toLowerCase();

/**
 * 按输入筛清单。空着：置顶的几家在前，其余按名字排。
 * 有输入：每个词都得出现在名字、id、中文别名或域名里（不分大小写）；置顶的命中了仍然排前面。
 */
export function searchProviders(query: string, all: readonly ProviderPreset[] = PROVIDERS): { pinned: ProviderPreset[]; others: ProviderPreset[] } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (p: ProviderPreset): boolean => words.every((w) => haystack(p).includes(w));
  const index = new Map(all.map((p) => [p.id, p]));
  const pinned = PINNED.map((id) => index.get(id)).filter((p): p is ProviderPreset => p !== undefined && match(p));
  const others = all.filter((p) => !PINNED.includes(p.id) && match(p));
  return { pinned, others };
}
