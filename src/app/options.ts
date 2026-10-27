import "./boot.ts";
import { setupSettingsLayout } from "./settingsLayout.ts";
import { fetchLog, hasUnsavedChanges } from "../options/form.ts";
import { hostHooks, native } from "./native.ts";
import { reasonOf } from "../lib/reason.ts";
import { icon } from "../ui/icons.ts";
import type { Update } from "../lib/update.ts";
import {
  RELEASES_PAGE,
  autoCheckEnabled,
  autoInstallEnabled,
  canSelfUpdate,
  checkForUpdate,
  currentVersion,
  downloadAndInstall,
  isDebugBuild,
  lastFailure,
  markChecked,
  readyVersion,
  setAutoCheck,
  setAutoInstall,
  skipVersion,
} from "./update.ts";

/**
 * App 的设置页就是扩展的设置页，另加底部主导航、
 * 两个「分享…」——「导出 JSON」和「下载 JSON」都只是写进下载目录，要把文件弄到
 * 电脑上还得再开一个文件管理器；分享面板一步到位（发给自己的聊天窗口、存网盘、
 * AirDrop 一类都从这里走）——以及末尾那个「更新」。
 *
 * 「更新」只在 App 里出现：扩展有应用商店管升级，App 是自己装的 APK，
 * 不自己问一声就没人告诉它有新版本。
 *
 * 页面本身的手机适配在 options/options.html 的那段媒体查询里，两端共用。
 */

const bar = document.createElement("nav");
bar.className = "phone-settings-nav"; bar.setAttribute("aria-label", "Main navigation");
for (const [name, href, glyph] of [["Reading", "index.html#articles", "book"], ["Vocabulary", "index.html#words", "words"], ["Settings", "options.html", "settings"]] as const) {
  const link = document.createElement("a"); link.href = href;
  const label = document.createElement("span"); label.textContent = name;
  link.append(icon(glyph), label);
  if (name === "Settings") { link.className = "active"; link.setAttribute("aria-current", "page"); link.addEventListener("click", e => e.preventDefault()); }
  else link.addEventListener("click", e => { if (!leaveAnyway()) e.preventDefault(); });
  bar.append(link);
}
document.body.append(bar);

/*
 * 带着没保存的修改离开要问一声。扩展里靠 beforeunload，WebView 不弹那个框，两条退路都得自己拦：
 * 底部导航，和系统的返回键（宿主先来问 beforeBack，回 true 表示这一下我接了、别退）。
 */
const leaveAnyway = (): boolean => !hasUnsavedChanges() || confirm("You have unsaved changes. Leave without saving?");
hostHooks.beforeBack = () => !leaveAnyway();

const bridge = native();
const stamp = (): string => new Date().toISOString().slice(0, 10);

/**
 * 在某个按钮后面补一个「分享…」。宿主没提供分享桥（普通浏览器里调试）时什么都不加。
 * 文件名跟着旁边那个下载按钮走：同一份东西，分享出去和存下来该叫同一个名字。
 */
function addShare(afterId: string, label: string, filename: () => string, load: () => Promise<unknown>): void {
  const anchor = document.getElementById(afterId);
  const shareFile = bridge?.shareFile;
  if (!shareFile || !anchor) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", () => {
    void (async () => {
      // 数据多的时候读出来要一会儿：按钮灰着，连点两下不会分享两份；读不出来就在按钮上说
      btn.disabled = true;
      try {
        const data = await load();
        shareFile(filename(), "application/json", JSON.stringify(data, null, 2));
        btn.textContent = label;
      } catch (err) {
        btn.textContent = `Could not load: ${reasonOf(err)}`;
      } finally {
        btn.disabled = false;
      }
    })();
  });
  anchor.after(btn);
}

addShare("export", "Share exported data…", () => `lectern-${stamp()}.json`, () =>
  chrome.runtime.sendMessage({ type: "data:export" }),
);
addShare("log-download", "Share logs…", () => `lectern-llm-log-${stamp()}.json`, fetchLog);

/* ==================== 更新 ==================== */

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;

/**
 * 页面末尾那个「更新」。不在宿主里（用普通浏览器打开 www/ 调试）时整块不出现——
 * 那种情形下既问不到装的是哪个版本，也没人能把包装上去。
 */
function addUpdateSection(): void {
  if (!native()) return;

  const box = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "Updates";
  box.append(legend);

  const selfUpdate = canSelfUpdate();
  const debug = isDebugBuild();

  const check = document.createElement("div");
  check.className = "field check";
  const autoLabel = document.createElement("label");
  autoLabel.htmlFor = "update-auto";
  autoLabel.textContent = "Check for updates daily";
  const auto = document.createElement("input");
  auto.id = "update-auto";
  auto.type = "checkbox";
  auto.style.width = "auto";
  auto.checked = autoCheckEnabled();
  auto.addEventListener("change", () => setAutoCheck(auto.checked));
  const autoHint = document.createElement("span");
  autoHint.className = "hint";
  autoHint.textContent = "Only asks GitHub for the latest release. Reading data and your current version are not sent.";
  check.append(autoLabel, auto, autoHint);
  box.append(check);

  // 自动下载并安装。老宿主（没有 updateReady）和 debug 包上这件事做不了，开关也就不摆出来
  if (selfUpdate && !debug && native()?.updateReady) {
    const install = document.createElement("div");
    install.className = "field check";
    const installLabel = document.createElement("label");
    installLabel.htmlFor = "update-install";
    installLabel.textContent = "Download and install automatically";
    const installBox = document.createElement("input");
    installBox.id = "update-install";
    installBox.type = "checkbox";
    installBox.style.width = "auto";
    installBox.checked = autoInstallEnabled();
    installBox.addEventListener("change", () => setAutoInstall(installBox.checked));
    const installHint = document.createElement("span");
    installHint.className = "hint";
    installHint.textContent =
      "Downloads on unmetered networks, then waits until you leave the app to install. " +
      "On Android 12 or later, installation can proceed automatically once unknown-app installation is allowed. Otherwise, an Install button appears on the home screen.";
    install.append(installLabel, installBox, installHint);
    box.append(install);
  }

  const row = document.createElement("div");
  row.className = "row";
  const checkBtn = document.createElement("button");
  checkBtn.type = "button";
  checkBtn.textContent = "Check for updates";
  const installBtn = document.createElement("button");
  installBtn.type = "button";
  installBtn.className = "primary";
  installBtn.textContent = "Download and install";
  installBtn.hidden = true;
  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.textContent = "Skip this version";
  skipBtn.hidden = true;
  const status = document.createElement("span");
  status.className = "muted small";
  const failed = lastFailure();
  const ready = readyVersion();
  status.textContent = `Current version: ${currentVersion()}`
    + (ready ? `, ${ready} downloaded` : "")
    // 自动安装是在人不在的时候做的，没成的话这儿是唯一看得见原因的地方
    + (failed?.message ? `; last automatic installation${failed.version ? ` ${failed.version}` : ""} failed: ${failed.message}` : "");
  row.append(checkBtn, installBtn, skipBtn, status);
  box.append(row);

  // Release 的说明是 markdown 原文，一律按纯文本渲染：这个页面和阅读器同源，
  // 手里攥着全部记录和宿主桥，不给远端的字符串任何变成标记的机会
  const notes = document.createElement("pre");
  notes.className = "update-notes muted small";
  notes.hidden = true;
  box.append(notes);

  const foot = document.createElement("p");
  foot.className = "muted small";
  box.append(foot);
  if (debug) {
    // 系统装不上签名不一致的包，会甩一句没头没尾的「应用未安装」，
    // 与其让人对着它猜，不如提前说清楚
    foot.textContent =
      "This app uses a debug signature (a local build or CI artifact). " +
      "It cannot be upgraded with an official release. Export your data, uninstall this build, install the release, then import your data.";
    installBtn.remove();
  } else if (!selfUpdate) {
    foot.textContent = "This app version cannot download updates. Download one from the Releases page.";
    installBtn.remove();
  } else {
    foot.textContent =
      "Updates are downloaded from GitHub Releases and installed by Android " +
      "(you may be asked to allow unknown-app installation). Upgrading preserves the app's stored data.";
  }

  /*
   * 地址写成可以选中的文字，不做成链接：App 里点站外链接一律进阅读器（见 boot.ts），
   * 而 Releases 是个用来下文件的页面，进了阅读器就是条死路。长按复制，去浏览器开。
   */
  const linkLine = document.createElement("p");
  linkLine.className = "update-link muted small";
  linkLine.textContent = `Manual download: ${RELEASES_PAGE}`;
  box.append(linkLine);

  let found: Update | null = null;

  const show = (update: Update | null): void => {
    found = update;
    installBtn.hidden = !update || debug || !selfUpdate;
    skipBtn.hidden = !update;
    notes.hidden = !update?.notes;
    notes.textContent = update?.notes ?? "";
  };

  checkBtn.addEventListener("click", () => {
    void (async () => {
      checkBtn.disabled = true;
      status.textContent = "Checking…";
      show(null);
      try {
        markChecked();
        const update = await checkForUpdate();
        if (!update) {
          status.textContent = `Up to date (${currentVersion()})`;
          return;
        }
        show(update);
        status.textContent = `New version available: ${update.version} (${mb(update.apk.size)}); current version: ${currentVersion()}`;
      } catch (err) {
        status.textContent = `Update check failed: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        checkBtn.disabled = false;
      }
    })();
  });

  installBtn.addEventListener("click", () => {
    const update = found;
    if (!update) return;
    void (async () => {
      installBtn.disabled = true;
      checkBtn.disabled = true;
      status.textContent = "Downloading…";
      try {
        await downloadAndInstall(update, (received, total) => {
          // 对方没报长度时 total 是 0，只报已下多少
          status.textContent = total
            ? `Downloading ${mb(received)} / ${mb(total)}`
            : `Downloading ${mb(received)}`;
        });
        status.textContent = "Downloaded. Follow Android's prompts to install.";
      } catch (err) {
        status.textContent = `Download failed: ${err instanceof Error ? err.message : String(err)}`;
        installBtn.disabled = false;
      } finally {
        checkBtn.disabled = false;
      }
    })();
  });

  skipBtn.addEventListener("click", () => {
    if (found) skipVersion(found.version);
    status.textContent = "This version will be skipped. You will still be notified about the next release.";
    show(null);
  });

  document.body.append(box);

  // 从首页那条提示点进来的：直接滚到这儿，并且顺手查一次
  if (location.hash === "#update") {
    box.scrollIntoView({ block: "center" });
    checkBtn.click();
  }
}

addUpdateSection();
setupSettingsLayout();
