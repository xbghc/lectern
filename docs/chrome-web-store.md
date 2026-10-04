# 上架 Chrome 应用商店

可见范围选「不公开」（有链接的人才能安装）。这份文档是提交时要填的全部内容，照着后台的栏目贴进去。
商店规则会变，栏目名以开发者后台的实际页面为准。

## 步骤

1. 用 Google 账号打开 <https://chrome.google.com/webstore/devconsole>，付一次性 5 美元注册费。
2. 「新建项目」，上传 Release 里的 `lectern-extension-vX.Y.Z.zip`。
3. 「商品详情」：按下面的文案填，语言先选中文（简体），再添加英语填英文那份。
   图标用 `src/icons/icon128.png`，截图用 `docs/store/` 下的五张（1280×800）。
4. 「隐私权」：按下面「隐私页」一节填。隐私政策网址填 <https://xbghc.github.io/lectern/privacy/>。
5. 「分发」：可见范围选「不公开」，地区全选。
6. 提交审核。要了全部网站的访问权限，会进深度审核，通常几天到几周。

商店版的扩展 ID 和「加载已解压的扩展程序」装的那个不一样，本机数据不会带过去：换装前先确认设备同步是通的，或导出一份文件。

## 商品详情

分类：效率 / 工具（Productivity → Tools）。

### 中文

**名称**（清单里的 `name`，上传后自动带出）：Lectern — 阅读时用到的工具

**简短说明**（清单里的 `description`）：记录每篇文章的专注片段与阅读进度；在文章页划词即用 MiniMax 翻译并存档，之后用间隔重复复习。

**详细说明**：

```
Lectern 是一张读书台：读网页文章时用得到的工具都放在这儿。

· 阅读追踪：自动认出文章页，记录每次专注了多久、读了多少、读到哪一段；重新打开时跳回上次的位置。
· 划词翻译与讲解：选中英文，给出结合上下文的翻译和用法讲解，句子里的生词逐个讲开。
· 截图翻译：框选图片里的文字，在本机识别后翻译。
· 复习：查过的词自动做成卡片，用 FSRS 间隔重复安排复习。
· 多设备：可以连接自己部署的同步服务器，在电脑和安卓 App 之间合并记录。

使用前请注意：
· 需要你自己的 MiniMax API Key，在设置页填写。没有 Key 时不会记录文章，也不能翻译。
· 填了 Key 之后，你打开的网页的网址、标题和正文会自动发给模型，用来判断它是不是文章。可以在设置页的「文章记录黑名单」里排除网站。
· 设备同步需要自己部署后端，不启用时所有数据只留在本机。
· 界面目前只有中文。

源代码与说明：https://github.com/xbghc/lectern
```

### English

**Name**: Lectern — reading tools in one place

**Short description**: Tracks focus sessions and progress on each article; select text to translate and save it with MiniMax, then review with spaced repetition.

**Detailed description**:

```
Lectern is a reading desk: the tools you need while reading articles on the web, in one place.

· Reading tracker: detects article pages, records how long you focused, how much you read and where you stopped, and jumps back there next time.
· Translate and explain: select English text to get a translation in context, a usage note, and each unfamiliar word explained.
· Screenshot translation: draw a box around text in an image; it is recognized on your device and then translated.
· Review: looked-up words become cards scheduled with FSRS spaced repetition.
· Multiple devices: optionally connect a sync server you host yourself to merge records between computers and the Android app.

Before you install:
· You need your own MiniMax API key, entered in settings. Without a key nothing is recorded or translated.
· Once a key is set, the URL, title and text of pages you open are sent to the model automatically to decide whether each page is an article. Exclude sites with the "article blocklist" in settings.
· Device sync requires a backend you deploy yourself. With sync off, all data stays on your device.
· The interface is currently Chinese only.

Source code and documentation: https://github.com/xbghc/lectern
```

## 隐私页

### 单一用途（Single purpose）

```
Lectern assists reading articles on the web: it tracks reading progress and focus time on article pages, translates and explains text the user selects, and schedules review of the words they looked up.
```

### 权限理由（Permission justification）

| 权限 | 填这段 |
|---|---|
| `storage` | Stores the user's settings and their API key for the model service locally. |
| `unlimitedStorage` | Reading records, saved article text and review cards are kept on the device in IndexedDB and grow beyond the default quota over months of use. |
| `alarms` | Runs the optional device-sync cycle once a minute while the service worker would otherwise be asleep. |
| `tabs` | Reads the URL and title of the active tab to show that page's reading status in the popup, notices tab switches and closes to end a focus session, and opens the extension's own dashboard and settings pages. |
| `activeTab` | Captures the visible area of the current tab when the user triggers screenshot translation from the popup, shortcut or context menu. |
| `contextMenus` | Adds one context-menu entry that starts screenshot translation. |
| `offscreen` | Runs Tesseract (WebAssembly) in a worker inside an offscreen document to recognize text in the user's screenshot locally. |
| `sidePanel` | Shows the words looked up on the current article in the browser side panel. |
| 主机权限 `http://*/*`、`https://*/*` | Articles can be on any website, so the content script must run on any page to measure reading progress and to offer translation of selected text. The background also re-fetches an article's own URL when the user asks to re-check a saved record, and sends requests to the model service and the sync server address the user configured. |
| 远程代码（Remote code） | 选 No。所有脚本、wasm 和字体都随包提供。 |

### 数据使用（Data usage）

勾选：

- **Web history / 网络记录**：文章页的网址和标题。
- **Website content / 网站内容**：文章正文、用户选中的文字。
- **User activity / 用户活动**：阅读进度、专注时间、按钮点击次数。
- **Authentication information / 身份验证信息**：用户自己填的 API Key 和同步 Token，只存在本机。

三条声明都勾选：不向第三方出售或转让数据（已批准的用途除外）；不用于与单一用途无关的目的；不用于信用评估或放贷。

## 审核里最可能被问到的一点

填了 API Key 之后，**每个打开的网页的网址、标题和正文都会自动发给模型做文章判别**。商店的用户数据政策要求这类收集有「显著披露」并取得同意。
现在的披露在商店说明和隐私政策里，扩展内部没有首次使用时的确认步骤。如果审核以此打回，需要在设置页首次保存 API Key 时加一个明确的同意提示。
