import { el } from "../popup/dom.ts";

import { hostnameOf } from "../lib/url.ts";
import type { ReadingActivity } from "../lib/activity.ts";

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min${rest ? ` ${rest} s` : ""}` : `${rest} s`;
}
export const minutes = (ms: number): string => (ms / 60_000).toLocaleString("en-US", { maximumFractionDigits: 1 });
export const time = (ts: number): string => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

export function weekChart(activity: ReadingActivity): HTMLElement {
  const chart = el("div", { class: "focus-week", role: "img", "aria-label": activity.days.map(d =>
    `${new Date(d.startTs).toLocaleDateString("en-US")}: ${duration(d.totalMs)}`).join("; ") });
  const max = Math.max(1, ...activity.days.map(d => d.totalMs));
  for (const [i, day] of activity.days.entries()) {
    chart.append(el("div", { class: `focus-day${i === 6 ? " is-today" : ""}`, title: duration(day.totalMs) }, [
      el("div", { class: "focus-bar-area" }, [el("span", {}, [minutes(day.totalMs)]),
        el("i", { style: `--bar-height:${day.totalMs / max * 56}px` })]),
      el("small", {}, [i === 6 ? "Today" : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(day.startTs).getDay()]!]),
    ]));
  }
  return chart;
}

export function sessionTimeline(activity: ReadingActivity, selectedId?: string): HTMLElement {
  const section = el("section", { class: "focus-rhythm" });
  const sessions = activity.sessions;
  const first = sessions[0];
  const last = sessions.at(-1);
  const start = first ? Math.floor(first.startTs / 3_600_000) * 3_600_000 : activity.today.startTs;
  const end = last ? Math.ceil(Math.max(...sessions.map(s => s.endTs)) / 3_600_000) * 3_600_000 : start;
  section.append(el("div", { class: "focus-section-heading" }, [el("h3", {}, ["Today's timeline"]),
    el("span", {}, [first ? `${time(start)} – ${time(end)}` : "No focus sessions yet"])]));
  if (!first) return section;
  const row = el("div", { class: "focus-timeline", role: "group", "aria-label": "Today's focus sessions" });
  const detail = el("div", { class: "focus-session-detail", "aria-live": "polite" });
  const select = (id: string): void => {
    const s = sessions.find(s => s.id === id)!;
    for (const b of row.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String(b.dataset.session === id));
    detail.replaceChildren(el("span", {}, [`${time(s.startTs)}–${time(s.endTs)} · ${hostnameOf(s.url) || s.title}`]),
      el("strong", {}, [duration(s.endTs - s.startTs)]));
  };
  for (const s of sessions) {
    const label = `${time(s.startTs)}–${time(s.endTs)} · ${duration(s.endTs - s.startTs)} · ${hostnameOf(s.url) || s.title}`;
    const b = el("button", { type: "button", class: `focus-segment${s.live ? " is-current" : ""}`,
      "data-session": s.id, "aria-label": label, title: label,
      style: `--start:${(s.startTs - start) / Math.max(1, end - start) * 100}%;--length:${(s.endTs - s.startTs) / Math.max(1, end - start) * 100}%` });
    b.addEventListener("click", () => select(s.id)); row.append(b);
  }
  select(sessions.some(s => s.id === selectedId) ? selectedId! : last!.id);
  section.append(row, detail);
  return section;
}
