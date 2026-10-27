import type { Article, Snippet } from "../types.ts";
import type { ActivitySession } from "../lib/activity.ts";
import { readingReport, type ReportRange } from "../lib/readingReport.ts";
import { el } from "../popup/dom.ts";
import { icon } from "../ui/icons.ts";
import { minutes } from "../ui/activity.ts";

const date = (ts: number): string => new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
let range: ReportRange = 7;
let selected = 6;
let request = 0;
export async function renderMobileStatistics(root: HTMLElement): Promise<void> {
  const turn = ++request;
  const [activity, records, vocabulary] = await Promise.all([
    chrome.runtime.sendMessage({ type: "stats:activity", days: 30 }) as Promise<{ sessions: ActivitySession[] }>,
    chrome.runtime.sendMessage({ type: "articles:list" }) as Promise<{ articles: Article[] }>,
    chrome.runtime.sendMessage({ type: "snippets:list" }) as Promise<{ snippets: Snippet[] }>,
  ]);
  if (turn !== request) return;
  const now = Date.now();
  const paint = (): void => {
    const report = readingReport(activity.sessions, records.articles, vocabulary.snippets, now, range);
    selected = Math.min(selected, report.groups.length - 1);
    const group = report.groups[selected]!;
    const interval = (start: number, end: number): string => date(start) + (end - start > 26 * 3600_000 ? ` — ${date(end - 1)}` : "");
    const ranges = el("div", { class: "phone-stat-ranges", role: "group", "aria-label": "统计时间范围" });
    for (const [value, label] of [[1, "今天"], [7, "近 7 天"], [30, "近 30 天"]] as const) {
      const button = el("button", { type: "button", "aria-pressed": String(range === value), class: range === value ? "active" : "", "data-track": "stats.range" }, [label]);
      button.onclick = () => { range = value; selected = value === 30 ? 5 : value - 1; paint(); root.querySelector<HTMLButtonElement>(`.phone-stat-ranges [aria-pressed=true]`)?.focus(); };
      ranges.append(button);
    }
    const total = Math.floor(report.totalMs / 60_000);
    const hero = el("section", { class: "phone-stat-hero" }, [
      el("div", { class: "row between" }, [el("span", {}, ["专注阅读"]), el("small", {}, [interval(report.groups[0]!.startTs, report.groups.at(-1)!.endTs)])]),
      el("div", { class: "phone-stat-total" }, [...(total >= 60 ? [String(Math.floor(total / 60)), el("small", {}, ["小时"])] : []), String(total % 60), el("small", {}, ["分钟"])]),
      el("div", { class: "phone-stat-summary" }, [[report.readingDays, "天", "有阅读"], [report.completed, "篇", "读完文章"], [report.words, "个", "收藏生词"]].map(([n, unit, label]) => el("span", {}, [el("strong", {}, [String(n), el("small", {}, [String(unit)])]), String(label)]))),
    ]);
    const heading = (title: string, note: string): HTMLElement => el("div", { class: "row between" }, [el("h2", {}, [title]), el("span", {}, [note])]);
    const bars = el("div", { class: "phone-stat-bars", role: "group", "aria-label": "选择时间查看阅读时长" });
    const max = Math.max(1, ...report.groups.map(g => g.totalMs));
    report.groups.forEach((g, i) => {
      const label = range === 1 || (range === 7 && i === 6) ? "今天" : date(g.startTs) + (range === 30 ? "起" : "");
      const button = el("button", { type: "button", class: i === selected ? "active" : "", "aria-pressed": String(i === selected), "aria-label": `${interval(g.startTs, g.endTs)}，${minutes(g.totalMs)} 分钟`, "data-track": "stats.period" }, [
        el("span", { class: "stat-bar-value" }, [String(minutes(g.totalMs))]),
        el("span", { class: "stat-bar-track" }, [el("i", { style: `height:${g.totalMs ? Math.max(3, g.totalMs / max * 100) : 0}%` })]), el("small", {}, [label]),
      ]);
      button.onclick = () => { selected = i; paint(); root.querySelector<HTMLButtonElement>(".phone-stat-bars [aria-pressed=true]")?.focus(); };
      bars.append(button);
    });
    const chart = el("section", { class: "phone-stat-section" }, [heading("阅读时长", range === 30 ? "每 5 天合计" : "分钟"), bars,
      el("div", { class: "phone-stat-selection", "aria-live": "polite" }, [el("span", {}, [interval(group.startTs, group.endTs)]), el("strong", {}, [`${minutes(group.totalMs)} 分钟`])])]);
    const content = el("section", { class: "phone-stat-section" }, [heading("阅读内容", "所选时段")]);
    for (const [name, ms, titles, glyph] of [["文章阅读", group.articleMs, group.titles.articles, "book"], ["书籍阅读", group.bookMs, group.titles.books, "shelf"]] as const) {
      content.append(el("div", { class: "phone-stat-source" }, [icon(glyph), el("div", {}, [el("strong", {}, [name]), el("small", { title: titles.join("、") }, [titles.join("、") || "暂无阅读记录"])]), el("b", {}, [String(minutes(ms)), el("small", {}, [" 分"])])]));
    }
    const distribution = el("section", { class: "phone-stat-section" }, [heading("内容分布", range === 1 ? "今天" : `近 ${range} 天`),
      el("div", { class: `phone-stat-distribution${report.totalMs ? "" : " is-empty"}`, role: "img", "aria-label": `文章 ${minutes(report.articleMs)} 分钟，书籍 ${minutes(report.bookMs)} 分钟` }, [el("i", { style: `width:${report.articleMs / Math.max(1, report.totalMs) * 100}%` })]),
      el("div", { class: "phone-stat-legend" }, [el("span", {}, [el("i"), `文章 ${minutes(report.articleMs)} 分`]), el("span", {}, [el("i"), `书籍 ${minutes(report.bookMs)} 分`])])]);
    root.replaceChildren(ranges, hero, chart, content, distribution, el("p", { class: "phone-data-note" }, ["按本地日期统计已保存的阅读记录；生词按词条去重。"]));
  };
  paint();
}
