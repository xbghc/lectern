import type { Article, Snippet } from "../types.ts";
import type { ActivitySession } from "../lib/activity.ts";
import { readingReport, type ReportRange } from "../lib/readingReport.ts";
import { el } from "../popup/dom.ts";
import { icon } from "../ui/icons.ts";
import { minutes } from "../ui/activity.ts";

const date = (ts: number): string => new Date(ts).toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
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
    const ranges = el("div", { class: "phone-stat-ranges", role: "group", "aria-label": "Statistics date range" });
    for (const [value, label] of [[1, "Today"], [7, "Last 7 days"], [30, "Last 30 days"]] as const) {
      const button = el("button", { type: "button", "aria-pressed": String(range === value), class: range === value ? "active" : "", "data-track": "stats.range" }, [label]);
      button.onclick = () => { range = value; selected = value === 30 ? 5 : value - 1; paint(); root.querySelector<HTMLButtonElement>(`.phone-stat-ranges [aria-pressed=true]`)?.focus(); };
      ranges.append(button);
    }
    const total = Math.floor(report.totalMs / 60_000);
    const hero = el("section", { class: "phone-stat-hero" }, [
      el("div", { class: "row between" }, [el("span", {}, ["Focused reading"]), el("small", {}, [interval(report.groups[0]!.startTs, report.groups.at(-1)!.endTs)])]),
      el("div", { class: "phone-stat-total" }, [...(total >= 60 ? [String(Math.floor(total / 60)), el("small", {}, [" h "])] : []), String(total % 60), el("small", {}, [" min"])]),
      el("div", { class: "phone-stat-summary" }, [[report.readingDays, report.readingDays === 1 ? "day" : "days", "Reading days"], [report.completed, report.completed === 1 ? "article" : "articles", "Articles finished"], [report.words, report.words === 1 ? "word" : "words", "Words saved"]].map(([n, unit, label]) => el("span", {}, [el("strong", {}, [String(n), el("small", {}, [" " + String(unit)])]), String(label)]))),
    ]);
    const heading = (title: string, note: string): HTMLElement => el("div", { class: "row between" }, [el("h2", {}, [title]), el("span", {}, [note])]);
    const bars = el("div", { class: "phone-stat-bars", role: "group", "aria-label": "Select a period to view reading time" });
    const max = Math.max(1, ...report.groups.map(g => g.totalMs));
    report.groups.forEach((g, i) => {
      const label = range === 1 || (range === 7 && i === 6) ? "Today" : date(g.startTs) + (range === 30 ? " onward" : "");
      const button = el("button", { type: "button", class: i === selected ? "active" : "", "aria-pressed": String(i === selected), "aria-label": `${interval(g.startTs, g.endTs)}, ${minutes(g.totalMs)} min`, "data-track": "stats.period" }, [
        el("span", { class: "stat-bar-value" }, [String(minutes(g.totalMs))]),
        el("span", { class: "stat-bar-track" }, [el("i", { style: `height:${g.totalMs ? Math.max(3, g.totalMs / max * 100) : 0}%` })]), el("small", {}, [label]),
      ]);
      button.onclick = () => { selected = i; paint(); root.querySelector<HTMLButtonElement>(".phone-stat-bars [aria-pressed=true]")?.focus(); };
      bars.append(button);
    });
    const chart = el("section", { class: "phone-stat-section" }, [heading("Reading time", range === 30 ? "5-day totals" : "minutes"), bars,
      el("div", { class: "phone-stat-selection", "aria-live": "polite" }, [el("span", {}, [interval(group.startTs, group.endTs)]), el("strong", {}, [`${minutes(group.totalMs)} min`])])]);
    const content = el("section", { class: "phone-stat-section" }, [heading("Reading activity", "Selected period")]);
    for (const [name, ms, titles, glyph] of [["Articles", group.articleMs, group.titles.articles, "book"], ["Books", group.bookMs, group.titles.books, "shelf"]] as const) {
      content.append(el("div", { class: "phone-stat-source" }, [icon(glyph), el("div", {}, [el("strong", {}, [name]), el("small", { title: titles.join(", ") }, [titles.join(", ") || "No reading records"])]), el("b", {}, [String(minutes(ms)), el("small", {}, [" min"])])]));
    }
    const distribution = el("section", { class: "phone-stat-section" }, [heading("Reading breakdown", range === 1 ? "Today" : `Last ${range} days`),
      el("div", { class: `phone-stat-distribution${report.totalMs ? "" : " is-empty"}`, role: "img", "aria-label": `Articles ${minutes(report.articleMs)} min; books ${minutes(report.bookMs)} min` }, [el("i", { style: `width:${report.articleMs / Math.max(1, report.totalMs) * 100}%` })]),
      el("div", { class: "phone-stat-legend" }, [el("span", {}, [el("i"), `Articles ${minutes(report.articleMs)} min`]), el("span", {}, [el("i"), `Books ${minutes(report.bookMs)} min`])])]);
    root.replaceChildren(ranges, hero, chart, content, distribution, el("p", { class: "phone-data-note" }, ["Based on saved sessions in your local time zone. Duplicate words are counted once."]));
  };
  paint();
}
