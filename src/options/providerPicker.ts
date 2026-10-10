import type { LlmConfig, LlmProtocol } from "../types.ts";
import { CUSTOM_PROVIDER, findProvider, searchProviders } from "../lib/providers.ts";
import type { ProviderPreset } from "../lib/providers.ts";
import { PROVIDERS } from "../lib/providers.generated.ts";

/**
 * 设置页里「选一家模型服务」的那一组控件：搜索框筛清单，列表里点一家，
 * 协议、Base URL、模型候选跟着填上。选的只是个起点——地址和模型名之后都可以手改。
 *
 * 用原生的 <select size> 当列表而不是自己画一个下拉：键盘操作、读屏、手机上的原生选择器都是现成的。
 */
export interface PickerElements {
  search: HTMLInputElement;
  list: HTMLSelectElement;
  protocol: HTMLSelectElement;
  baseUrl: HTMLInputElement;
  model: HTMLInputElement;
  models: HTMLDataListElement;
  doc: HTMLAnchorElement;
}

export interface ProviderPicker {
  /** 把存着的配置摆上去。地址和模型以存着的为准，不拿清单里的覆盖。 */
  show(cfg: Pick<LlmConfig, "provider" | "protocol" | "baseUrl" | "model">): void;
  /** 现在选的是哪家：清单里的 id、`custom`，或者空串（还没选）。 */
  provider(): string;
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function group(label: string, presets: readonly ProviderPreset[]): HTMLOptGroupElement {
  const g = document.createElement("optgroup");
  g.label = label;
  for (const p of presets) g.append(option(p.id, p.name));
  return g;
}

export function setupProviderPicker(els: PickerElements): ProviderPicker {
  let current = "";
  els.search.placeholder = `搜索 ${PROVIDERS.length} 家，例如 openai、deepseek、智谱`;

  /** 按搜索框里的字重画列表。当前选中的那家要是被筛掉了，列表里就没有高亮——选择本身不变。 */
  const render = (): void => {
    const query = els.search.value.trim();
    const { pinned, others } = searchProviders(query);
    els.list.replaceChildren();
    if (query) {
      const hits = [...pinned, ...others];
      if (hits.length) els.list.append(group(`匹配的 ${hits.length} 家`, hits));
    } else {
      els.list.append(group("常用", pinned), group("全部（按名称）", others));
    }
    // 搜不到的时候正是要用它的时候，所以不管筛成什么样它都在
    els.list.append(option(CUSTOM_PROVIDER, "自定义地址…"));
    els.list.value = current;
    if (els.list.value !== current) els.list.selectedIndex = -1;
  };

  /** 选中的这一家带来的东西：协议定死（自定义才能改）、模型候选、文档链接。 */
  const describe = (id: string): ProviderPreset | undefined => {
    const preset = findProvider(id);
    els.protocol.disabled = preset !== undefined;
    els.models.replaceChildren(...(preset?.models ?? []).map((m) => option(m, "")));
    els.model.placeholder = preset?.models[0] ? `例如 ${preset.models[0]}` : "模型名";
    els.doc.hidden = !preset?.doc;
    if (preset?.doc) els.doc.href = preset.doc;
    return preset;
  };

  els.search.addEventListener("input", render);
  els.list.addEventListener("change", () => {
    if (!els.list.value || els.list.value === current) return;
    current = els.list.value;
    const preset = describe(current);
    if (!preset) return; // 自定义：地址、协议、模型都留给人填，已经填着的不动
    els.protocol.value = preset.protocol;
    els.baseUrl.value = preset.baseUrl;
    // 上一家的模型名在这一家多半不存在；清掉，免得保存时带过去
    if (!preset.models.includes(els.model.value.trim())) els.model.value = "";
    els.baseUrl.dispatchEvent(new Event("input", { bubbles: true }));
  });

  return {
    show(cfg) {
      current = cfg.provider;
      els.search.value = "";
      render();
      describe(current);
      els.protocol.value = cfg.protocol satisfies LlmProtocol;
      els.baseUrl.value = cfg.baseUrl;
      els.model.value = cfg.model;
    },
    provider: () => current,
  };
}
