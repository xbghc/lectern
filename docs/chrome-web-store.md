# Chrome 应用商店

已上架：<https://chromewebstore.google.com/detail/fpplijdeabekpbadojohidampfnjhcdf>（扩展 ID `fpplijdeabekpbadojohidampfnjhcdf`）。
这份文档是后台各栏填的内容的底稿，改了扩展的权限、数据去向或功能说明时照着更新后台；后半篇是自动发布怎么配。
商店规则会变，栏目名以开发者后台的实际页面为准。

## 首次上架时的步骤

1. 用 Google 账号打开 <https://chrome.google.com/webstore/devconsole>，付一次性 5 美元注册费；在 Settings 里填联系邮箱并验证。
2. 「新建项目」，上传 Release 里的 `lectern-extension-vX.Y.Z.zip`。
3. 「商品详情」：按下面的文案填，语言先选中文（简体），再添加英语填英文那份。
   图标用 `src/icons/icon128.png`，截图用 `docs/store/` 下的五张（1280×800）。
4. 「隐私权」：按下面「隐私页」一节填。隐私政策网址填 <https://xbghc.github.io/lectern/privacy/>。
5. 「分发」：选可见范围（公开能被搜到，不公开只有拿到链接的人能装），地区全选。
6. 提交审核。要了全部网站的访问权限，会进深度审核，通常几天到几周。

商店版的扩展 ID 和「加载已解压的扩展程序」装的那个不一样，本机数据不会带过去：换装前先确认设备同步是通的，或导出一份文件。

## 商品详情

分类：效率 / 工具（Productivity → Tools）。

### 中文

**名称**（清单里的 `name`，上传后自动带出）：Lectern — 阅读时用到的工具

**简短说明**（清单里的 `description`）：记录每篇文章的专注片段与阅读进度；在文章页划词即用你选的模型翻译并存档，之后用间隔重复复习。

**详细说明**：

```
Lectern 是一张读书台：读网页文章时用得到的工具都放在这儿。

· 阅读追踪：自动认出文章页，记录每次专注了多久、读了多少、读到哪一段；重新打开时跳回上次的位置。
· 划词翻译与讲解：选中英文，给出结合上下文的翻译和用法讲解，句子里的生词逐个讲开。
· 截图翻译：框选图片里的文字，在本机识别后翻译。
· 复习：查过的词自动做成卡片，用 FSRS 间隔重复安排复习。
· 多设备：可以连接自己部署的同步服务器，在电脑和安卓 App 之间合并记录。

使用前请注意：
· 需要你自己的模型服务 API Key：在设置页从两百来家服务商里选一家（OpenAI、Anthropic、DeepSeek、MiniMax 等，或自定义地址），填上模型名和 Key。没有 Key 时不会记录文章，也不能翻译。
· 填了 Key 之后，你打开的网页的网址、标题和正文会自动发给模型，用来判断它是不是文章。可以在设置页的「文章记录黑名单」里排除网站。
· 设备同步需要自己部署后端，不启用时所有数据只留在本机。
· 界面目前只有中文。

源代码与说明：https://github.com/xbghc/lectern
```

### English

**Name**: Lectern — reading tools in one place

**Short description**: Tracks focus sessions and progress on each article; select text to translate and save it with the model you choose, then review with spaced repetition.

**Detailed description**:

```
Lectern is a reading desk: the tools you need while reading articles on the web, in one place.

· Reading tracker: detects article pages, records how long you focused, how much you read and where you stopped, and jumps back there next time.
· Translate and explain: select English text to get a translation in context, a usage note, and each unfamiliar word explained.
· Screenshot translation: draw a box around text in an image; it is recognized on your device and then translated.
· Review: looked-up words become cards scheduled with FSRS spaced repetition.
· Multiple devices: optionally connect a sync server you host yourself to merge records between computers and the Android app.

Before you install:
· You need your own API key for a model service: pick one of about 200 providers in settings (OpenAI, Anthropic, DeepSeek, MiniMax and others, or a custom address) and enter a model name and key. Without a key nothing is recorded or translated.
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

### 测试说明（Test instructions）

这一栏上限 500 个字符，下面这份是 447 个（按字节算 495，贴近上限，改动时数一下）。没有 API Key 时扩展什么都不做，审核员需要一个 Key 才看得到翻译；
有的服务商（比如 MiniMax）的 Key 很长，这一栏放不下，那一页另有单独的凭据输入框就填在那里，没有就不给。给的话单独建一个额度很小的，审核过了就作废。

```
Needs an API key for a model service.
1. Options page opens after install: click "同意并开始" (Agree) at the top.
2. In "模型服务" pick a provider, enter a model and the key, click "保存并测试连接".
3. Open an English article, e.g. https://en.wikipedia.org/wiki/Reading . The popup shows reading progress.
4. In the popup click "本页启用划词翻译", then select text to see the translation.
5. Alt+Shift+S starts screenshot translation.
Sync is optional and off by default.
```

## 发给模型之前的确认

填了 API Key 之后，每个打开的网页的网址、标题和正文都会自动发给模型做文章判别。商店的用户数据政策要求这类收集有「显著披露」并取得同意，
所以从 0.3.18 起：

- 安装后设置页自动打开，顶部是一块说明，列出会自动发什么、哪些功能用到时发什么、发给谁；点「同意并开始」之前一个请求都不发。
- 从更早版本升上来、已经填过 Key 的，升级后设置页同样会自动打开一次，确认之前判别和翻译是停的。
- 同意可以在模型分区里撤回；它只属于这一份安装，不进导出文件。

这段说明、商店的详细说明、隐私政策三处讲的是同一件事，改一处要对一下另外两处。

## 自动发布

配好下面两个 Secret 之后，打 `v*` 标签发版时 `release.yml` 会在 GitHub Release 发出去之后调 `store.yml`，
把同一个 zip 传到商店并提交审核。没配时这一步自己跳过。审核跳不过，每个版本仍然要过审；商店信息（说明、截图、隐私声明）也还是在后台手改。

### 建凭据（一次性）

用的是服务账号：密钥不会过期。（OAuth 的 refresh token 在同意屏幕处于「测试中」时七天就失效，不适合放进 CI。）

1. 打开 <https://console.cloud.google.com/>，新建一个项目（名字随意），在「API 和服务」里搜索并启用 **Chrome Web Store API**。
2. 打开 <https://console.cloud.google.com/iam-admin/serviceaccounts>，在这个项目里创建一个服务账号。不用给它任何角色。
3. 点进这个服务账号 →「密钥」→「添加密钥」→「创建新密钥」→ 选 JSON。浏览器会下载一个 `.json` 文件，这就是凭据。
4. 打开 Chrome 应用商店的开发者后台 → **Account**（账号）页面，把服务账号的邮箱（形如 `xxx@项目名.iam.gserviceaccount.com`）加进去。
   一个发布者目前只能加一个服务账号。同一页上能看到 **Publisher ID**，记下来。
5. 把两样东西存成仓库的 Secret（在仓库目录下跑；文件路径换成第 3 步下载的那个）：

   ```bash
   gh secret set CWS_SERVICE_ACCOUNT_JSON -R xbghc/lectern < ~/Downloads/下载的密钥文件.json
   gh secret set CWS_PUBLISHER_ID -R xbghc/lectern        # 回车后粘贴 Publisher ID
   ```

6. 存好之后把下载的那个 `.json` 文件删掉。它等于这个发布者账号的上传权限，别进仓库、别发给任何人。

### 平时怎么用

- **发版**：不用多做什么。`gh run watch` 里多出一个「Chrome 应用商店」的 job，日志里有商店回的状态。
- **上一版还在审**：商店不收新包，这个 job 会失败（Release 和 APK 不受影响）。等上一版出了结果，
  到 Actions → Chrome Web Store → Run workflow，填同一个标签重跑。
- **本机手动传**：`CWS_SERVICE_ACCOUNT_JSON="$(cat key.json)" CWS_PUBLISHER_ID=... node --experimental-strip-types scripts/store-upload.ts lectern-extension-vX.Y.Z.zip`，
  加 `--no-publish` 只传成草稿、不提交审核。

脚本对着商店 API 的 V2 文档写的，发出去的请求有测试（`test/storeUpload.test.ts`，商店那头是假的）。
2026-10-10 用 v0.3.18 对真的商店跑通过一次：上传回 `SUCCEEDED`，提交回 `PENDING_REVIEW`。

日志里花括号会显示成 `***`：密钥文件是多行的 JSON，GitHub 把它的每一行都当成要遮住的内容，单独成行的 `{`、`}` 也在其中。不影响功能。
