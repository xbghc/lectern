import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * 从 models.dev 取模型服务商的清单，裁成扩展用得上的那一小份，写进 src/lib/providers.generated.ts。
 *
 *   npm run providers:update            # 联网取最新的
 *   npm run providers:update -- 文件.json  # 用手头已有的一份 api.json
 *
 * 为什么是构建时的快照而不是运行时去拉：整份数据 5MB 多，而且运行时拉意味着每个安装都要向第三方发请求、
 * 断网时连提供商都选不了。快照进仓库，更新就是重跑一次、看一眼 diff。
 *
 * 只收两种协议的提供商（见 src/lib/llmWire.ts）：
 *   - npm 是 @ai-sdk/anthropic 的 → Anthropic Messages
 *   - npm 是 @ai-sdk/openai、@ai-sdk/openai-compatible、@openrouter/ai-sdk-provider 的 → OpenAI Chat Completions
 * 其余的（Bedrock、Vertex、Azure 这类要签名或要按账号拼地址的）不收，用的人走「自定义」。
 */

const SOURCE = "https://models.dev/api.json";
const OUT = fileURLToPath(new URL("../src/lib/providers.generated.ts", import.meta.url));
/** 每家最多留几个模型名给设置页当候选。只是候选，模型名可以手填。 */
const MAX_MODELS = 20;

type Protocol = "anthropic" | "openai";

const FAMILY: Record<string, Protocol> = {
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/openai": "openai",
  "@ai-sdk/openai-compatible": "openai",
  "@openrouter/ai-sdk-provider": "openai",
};

/**
 * models.dev 没给地址的几家。官方的 OpenAI 和 Anthropic 就在其中——它们的地址写在各自的 SDK 包里，清单里是空的。
 * 另外四家有自己的 SDK 包、但同时提供 OpenAI 兼容端点，用的人多，一并补上。
 * 这张表是整件事里唯一手工维护的部分，尽量别往里加。
 */
const OVERRIDES: Record<string, { protocol: Protocol; baseUrl: string }> = {
  openai: { protocol: "openai", baseUrl: "https://api.openai.com/v1" },
  anthropic: { protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  google: { protocol: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  groq: { protocol: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  xai: { protocol: "openai", baseUrl: "https://api.x.ai/v1" },
  mistral: { protocol: "openai", baseUrl: "https://api.mistral.ai/v1" },
};

interface SourceModel {
  id?: string;
  release_date?: string;
  status?: string;
  modalities?: { output?: string[] };
}
interface SourceProvider {
  id: string;
  name?: string;
  npm?: string;
  api?: string;
  doc?: string;
  models?: Record<string, SourceModel>;
}

export interface Preset {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  doc: string;
  models: string[];
}

/** 一家提供商 → 一条预设；用不上的返回 null。 */
export function toPreset(p: SourceProvider): Preset | null {
  const override = OVERRIDES[p.id];
  const protocol = override?.protocol ?? FAMILY[p.npm ?? ""];
  const baseUrl = (override?.baseUrl ?? p.api ?? "").trim().replace(/\/+$/, "");
  // 地址里带 ${账号ID} 这类占位符的，得按各人的账号拼，预设不了
  if (!protocol || !/^https?:\/\/[^${}\s]+$/.test(baseUrl)) return null;
  const models = Object.values(p.models ?? {})
    .filter((m) => m.id && m.status !== "deprecated" && (m.modalities?.output ?? ["text"]).includes("text"))
    .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? "") || a.id!.localeCompare(b.id!))
    .slice(0, MAX_MODELS)
    .map((m) => m.id!);
  return { id: p.id, name: (p.name ?? p.id).trim(), protocol, baseUrl, doc: /^https?:\/\//.test(p.doc ?? "") ? p.doc! : "", models };
}

export function render(presets: Preset[], fetched: string): string {
  const rows = presets.map((p) => `  ${JSON.stringify(p)},`).join("\n");
  return `// 由 scripts/update-providers.ts 生成，别手改；要更新就跑 npm run providers:update。
// 数据来自 ${SOURCE}（models.dev，MIT 许可），外加脚本里 OVERRIDES 手补的几家。
import type { ProviderPreset } from "./providers.ts";

/** 这份快照是哪天取的。 */
export const PROVIDERS_FETCHED = ${JSON.stringify(fetched)};

export const PROVIDERS: readonly ProviderPreset[] = [
${rows}
];
`;
}

async function main(): Promise<void> {
  const from = process.argv[2];
  const raw = from ? readFileSync(from, "utf8") : await (await fetch(SOURCE)).text();
  const source = JSON.parse(raw) as Record<string, SourceProvider>;
  const presets = Object.values(source)
    .map(toPreset)
    .filter((p): p is Preset => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id));
  for (const id of Object.keys(OVERRIDES)) {
    if (!presets.some((p) => p.id === id)) throw new Error(`models.dev 里找不到 ${id}：是改了 id，还是数据没取全？`);
  }
  writeFileSync(OUT, render(presets, new Date().toISOString().slice(0, 10)));
  const count = (protocol: Protocol): number => presets.filter((p) => p.protocol === protocol).length;
  console.log(`${presets.length} 家（OpenAI 协议 ${count("openai")}，Anthropic 协议 ${count("anthropic")}），源数据共 ${Object.keys(source).length} 家 → ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
