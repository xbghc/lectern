import "./boot.ts";
import { go, navigation } from "./boot.ts";
import { hostHooks } from "./native.ts";
import { PORT_TRANSLATE, type AskTurn, type Snippet, type TranslatePortOut } from "../types.ts";
import { CHAT_STORAGE_KEY, readChatThreads, type ChatMessage, type VocabularyThread } from "../lib/vocabularyChat.ts";
import { createUiTracker, isUiEvent } from "../lib/uiUsage.ts";
import { reasonOf } from "../lib/reason.ts";
import { icon, decorateIcons } from "../ui/icons.ts";
import { el } from "../popup/dom.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = $<HTMLTextAreaElement>("chat-input");
const send = $<HTMLButtonElement>("chat-send");
const main = $("chat-main");
const status = $("chat-status");
const picker = $<HTMLDialogElement>("chat-picker");
const history = $<HTMLDialogElement>("chat-history-dialog");
const tracker = createUiTracker(events => void chrome.runtime.sendMessage({ type: "ui:track", events }).catch(() => undefined));
let snippets: Snippet[] = [];
let threads: VocabularyThread[] = [];
let current: VocabularyThread;
let cancel: (() => void) | null = null;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let writes = Promise.resolve();
let ready = false;
let selected: string[] = [];
const say = (message: string): void => { status.textContent = message; };
const save = (): Promise<void> => {
  if (!ready) return writes;
  const snapshot = readChatThreads(threads.filter(t => t.messages.length || t.draft));
  writes = writes.then(() => chrome.storage.local.set({ [CHAT_STORAGE_KEY]: snapshot })).catch(() => { say("Could not save this conversation on your device. Try again later."); });
  return writes;
};
function controls(): void {
  const missing = current?.snippetIds.some(id => !snippets.some(s => s.id === id));
  send.disabled = !ready || !!cancel || !input.value.trim() || !current?.snippetIds.length || !!missing;
  $("chat-send").hidden = !!cancel; $("chat-stop").hidden = !cancel;
  $<HTMLButtonElement>("chat-select").disabled = !!cancel;
  for (const button of $("chat-starters").querySelectorAll("button")) button.disabled = !!cancel || !current?.snippetIds.length || !!missing;
}
function scrollEnd(): void { main.scrollTop = main.scrollHeight; }
function appendMessage(message: ChatMessage): HTMLElement {
  const text = el("div", { class: "chat-message-body" }, [message.text || (message.incomplete ? "Thinking…" : "")]);
  const content = el("div", {}, [...(message.role === "assistant" ? [el("span", { class: "chat-author" }, ["Lectern"])] : []), text]);
  if (message.incomplete && message.text) content.append(el("small", { class: "chat-incomplete" }, ["Incomplete"]));
  $("chat-messages").append(el("div", { class: `chat-message is-${message.role}` }, [
    ...(message.role === "assistant" ? [el("span", { class: "chat-avatar" }, [icon("spark")])] : []), content,
  ]));
  return text;
}
function paint(): void {
  $("chat-words").replaceChildren(...current.words.map(word => el("span", {}, [word])));
  if (!current.words.length) $("chat-words").append(el("span", {}, ["Choose words to practice"]));
  const messages = $("chat-messages"); messages.replaceChildren();
  if (current.messages.length) current.messages.forEach(appendMessage);
  else messages.append(el("div", { class: "phone-chat-welcome" }, [el("span", {}, [icon("chat")]), el("h2", {}, ["Put your reading into words."]),
    el("p", {}, [snippets.length ? "Bring context from your vocabulary. Practice a sentence or start a conversation." : "No words to practice yet. Translate and save a word while reading first."])]));
  const starters = current.messages.length
    ? [["Explain this word", "Explain how these words are used in their original context."], ["Practice another word", "Choose another selected word and ask me to write a sentence. Wait before giving the answer."]]
    : [["Role-play", "Start a role-play using these words. Ask me one question first."], ["Sentence practice", "Give me a sentence exercise using the selected words. Wait for my answer before giving feedback."], ["Explain in context", "Explain these words using the original passages I read."]];
  $("chat-starters").replaceChildren(...starters.map(([label, question]) => {
    const button = el("button", { type: "button" }, [label!, icon("arrow")]);
    button.onclick = () => start(question!); return button;
  }));
  input.value = current.draft;
  if (current.snippetIds.some(id => !snippets.some(s => s.id === id))) say("A word in this conversation was deleted. Choose another word to continue.");
  controls();
}
function newThread(ids = snippets.slice(0, 3).map(s => s.id)): void {
  cancel?.();
  current = { id: crypto.randomUUID(), title: "Vocabulary chat", snippetIds: ids,
    words: ids.map(id => snippets.find(s => s.id === id)!.text), messages: [], draft: "", updatedTs: Date.now() };
  // Empty "new conversation" taps must not evict actual history.
  threads = [current, ...threads.filter(t => t.messages.length || t.draft)].slice(0, 21);
  say(""); $("chat-config").hidden = true; paint(); scrollEnd(); void save();
}
function turns(): AskTurn[] {
  const result: AskTurn[] = [];
  for (let i = 1; i < current.messages.length; i++) {
    const before = current.messages[i - 1]!, after = current.messages[i]!;
    if (before.role === "user" && after.role === "assistant" && !after.incomplete) result.push({ question: before.text, answer: after.text });
  }
  return result.slice(-6);
}
function start(question: string): void {
  question = question.trim();
  if (!ready || cancel || !question || question.length > 1000 || !current.snippetIds.length) return;
  if (current.snippetIds.some(id => !snippets.some(s => s.id === id))) { say("Choose your practice words again."); return; }
  tracker.track("chat.send");
  const thread = current;
  const request = { snippetIds: [...thread.snippetIds], question, history: turns() };
  const reply: ChatMessage = { role: "assistant", text: "", incomplete: true };
  if (!thread.messages.length) thread.title = question.slice(0, 36);
  thread.messages.push({ role: "user", text: question }, reply); thread.messages = thread.messages.slice(-40);
  thread.draft = ""; thread.updatedTs = Date.now();
  threads = [thread, ...threads.filter(t => t !== thread)];
  input.value = ""; say(""); $("chat-config").hidden = true;
  paint(); const answer = $("chat-messages").lastElementChild!.querySelector<HTMLElement>(".chat-message-body")!;
  scrollEnd(); void save();
  let port: chrome.runtime.Port | undefined, settled = false;
  const finish = (error = "", needsConfig = false): void => {
    if (settled) return; settled = true; cancel = null;
    try { port?.disconnect(); } catch { /* already disconnected */ }
    if (!error) delete reply.incomplete;
    else {
      if (!thread.draft) thread.draft = question;
      input.value = thread.draft;
      if (!reply.text) reply.text = "No reply was generated.";
    }
    const pinned = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
    paint(); say(error); $("chat-config").hidden = !needsConfig;
    if (pinned) scrollEnd(); void save();
  };
  cancel = () => finish("Generation stopped. Edit your message and send it again."); controls();
  try {
    port = chrome.runtime.connect({ name: PORT_TRANSLATE });
    port.onMessage.addListener((message: TranslatePortOut) => {
      if (settled) return;
      if (message.type === "vocab-chat-partial") {
        const pinned = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
        reply.text = message.text.slice(0, 6000); answer.textContent = reply.text;
        if (pinned) scrollEnd();
      } else if (message.type === "vocab-chat-done") {
        if (message.res.ok) { reply.text = message.res.text; finish(); }
        else finish(message.res.error, message.res.needsConfig);
      }
    });
    port.onDisconnect.addListener(() => { if (!settled) finish("Connection interrupted. Check your model connection and try again."); });
    port.postMessage({ type: "vocab-chat", req: request });
  } catch (error) { finish(`Could not send: ${reasonOf(error)}`); }
}
function paintPicker(): void {
  const query = $<HTMLInputElement>("picker-search").value.trim().toLocaleLowerCase();
  const list = snippets.filter(s => `${s.text} ${s.translation}`.toLocaleLowerCase().includes(query));
  $("picker-list").replaceChildren(...list.map(s => {
    const checked = selected.includes(s.id);
    const button = el("button", { type: "button", class: "chat-word-option", "aria-pressed": String(checked) }, [
      el("span", {}, [el("strong", {}, [s.text]), el("small", {}, [s.translation])]), el("i", {}, checked ? [icon("check")] : []),
    ]);
    button.onclick = () => {
      if (checked && selected.length === 1) { $("picker-count").textContent = "Keep at least one word selected."; return; }
      if (!checked && selected.length >= 3) { $("picker-count").textContent = "Select up to three words at a time."; return; }
      selected = checked ? selected.filter(id => id !== s.id) : [...selected, s.id];
      paintPicker();
      [...$("picker-list").querySelectorAll("button")][list.findIndex(w => w.id === s.id)]?.focus({ preventScroll: true });
    };
    return button;
  }));
  if (!list.length) $("picker-list").textContent = snippets.length ? "No matching words." : "Your vocabulary is empty.";
  $("picker-count").textContent = `Selected: ${selected.length} / 3`;
}
function showHistory(): void {
  $("chat-history-list").replaceChildren(...threads.filter(t => t.messages.length || t.draft).map(t => {
    const row = el("div", { class: "chat-history-row" });
    const open = el("button", { type: "button", class: "phone-chat-history-item" }, [icon("chat"), el("div", {}, [el("h2", {}, [t.title]), el("p", {}, [t.words.join(" · ")]), el("small", {}, [new Date(t.updatedTs).toLocaleDateString("en-US")])]), icon("chevron")]);
    open.onclick = () => { cancel?.(); current = t; say(""); history.close(); paint(); scrollEnd(); };
    const remove = el("button", { type: "button", class: "mini danger", "aria-label": `Delete conversation: ${t.title}` }, ["Delete"]);
    remove.onclick = () => {
      if (!confirm(`Delete “${t.title}” and all its messages?`)) return;
      tracker.track("chat.delete");
      if (current === t) cancel?.();
      threads = threads.filter(item => item !== t);
      if (current === t) newThread();
      void save(); showHistory();
    };
    row.append(open, remove); return row;
  }));
  if (!$("chat-history-list").hasChildNodes()) $("chat-history-list").append(el("p", { class: "empty" }, ["No conversations yet. Start practicing with a word."]));
  if (!history.open) history.showModal();
}

decorateIcons();
$("chat-form").addEventListener("submit", event => { event.preventDefault(); start(input.value); });
input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); start(input.value); } });
input.addEventListener("input", () => { if (!ready) return; current.draft = input.value; controls(); clearTimeout(draftTimer); draftTimer = setTimeout(() => void save(), 250); });
$("chat-stop").onclick = () => cancel?.();
$("chat-new").onclick = () => { if (ready) newThread(); };
$("chat-history").onclick = () => { if (ready) showHistory(); };
$("history-close").onclick = () => history.close();
$("chat-select").onclick = async () => {
  if (!ready || cancel) return;
  try {
    const fresh = await chrome.runtime.sendMessage({ type: "snippets:list" }) as { snippets: Snippet[] };
    snippets = fresh.snippets.filter(s => s.kind !== "sentence");
    selected = current.snippetIds.filter(id => snippets.some(s => s.id === id));
    $<HTMLInputElement>("picker-search").value = ""; paintPicker(); picker.showModal();
  } catch (error) { say(`Could not load vocabulary: ${reasonOf(error)}`); }
};
$("picker-search").addEventListener("input", paintPicker);
$("picker-close").onclick = () => {
  if (!selected.length && snippets.length) { $("picker-count").textContent = "Select at least one word."; return; }
  current.snippetIds = [...selected]; current.words = selected.map(id => snippets.find(s => s.id === id)!.text);
  picker.close(); say(""); paint(); void save();
};
document.addEventListener("click", event => {
  const name = (event.target as Element)?.closest<HTMLElement>("[data-track]")?.dataset.track;
  if (isUiEvent(name)) tracker.track(name);
}, true);
const leave = async (): Promise<void> => { cancel?.(); clearTimeout(draftTimer); tracker.flush(); await save(); };
navigation.beforeLeave = leave;
window.addEventListener("pagehide", () => { void leave(); });
for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
  link.addEventListener("click", event => { event.preventDefault(); void go(link.getAttribute("href")!); });
}
hostHooks.visibility = visible => { if (!visible) { tracker.flush(); void save(); } };
hostHooks.beforeBack = () => {
  if (picker.open) { picker.close(); return true; }
  if (history.open) { history.close(); return true; }
  void go("index.html#words"); return true;
};
// Android IME may resize only the visual viewport; keep the composer above it.
const viewport = (): void => { const v = window.visualViewport; document.body.style.height = `${v?.height ?? window.innerHeight}px`; document.body.style.top = `${v?.offsetTop ?? 0}px`; };
window.visualViewport?.addEventListener("resize", viewport); window.visualViewport?.addEventListener("scroll", viewport); window.addEventListener("resize", viewport); viewport();

async function init(): Promise<void> {
  const [words, saved] = await Promise.all([
    chrome.runtime.sendMessage({ type: "snippets:list" }) as Promise<{ snippets: Snippet[] }>,
    chrome.storage.local.get(CHAT_STORAGE_KEY),
  ]);
  snippets = words.snippets.filter(s => s.kind !== "sentence");
  threads = readChatThreads(saved[CHAT_STORAGE_KEY]); ready = true; input.disabled = false;
  for (const thread of threads) for (const message of thread.messages) {
    if (message.incomplete && !message.text) message.text = "The previous reply was interrupted. You can send your message again.";
  }
  const id = new URLSearchParams(location.search).get("word");
  if (id && snippets.some(s => s.id === id)) newThread([id]);
  else if (threads[0]) { current = threads[0]; paint(); scrollEnd(); }
  else newThread();
}
void init().catch(error => {
  say(`Could not load vocabulary or conversations: ${reasonOf(error)}`);
  const retry = el("button", { type: "button", class: "mini" }, ["Retry"]);
  retry.onclick = () => location.reload(); status.append(retry);
});
