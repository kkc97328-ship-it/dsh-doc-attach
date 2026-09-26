# dsh-doc-attach 开发经验总结

面向后续开发 DeepSeek Harness（下称 DSH）插件的参考文档。所有内容来自本项目的真实开发过程——**踩过的坑都是实际发生过的**，没发生过的不会被写进来（见 [§5.6 关于「端口 3080 被占用」](#56-关于端口-3080-被占用一件事先澄清)）。

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/kkc97328-ship-it/dsh-doc-attach |
| npm | https://www.npmjs.com/package/dsh-doc-attach |
| 版本 | 0.1.2 |
| 开发日期 | 2026-09-26 ~ 09-27 |
| 许可证 | MIT |
| 规模 | 30 个文件入库；~5.5k 行；零运行时依赖 |
| 测试 | 109 项 / 8 套件（其中 4 套可在 CI 跑） |

> **本文件已脱敏。** 本地绝对路径、机器信息与个人信息一律以占位符表示（`<项目根目录>`、`<工作区>`、`<checkout>`、`<用户名>` 等）。文中**不含**任何 token、密码、API key、邮箱、手机号或内网地址。

---

## 1. 项目背景与目标

DSH 的 Web GUI **本身就支持图片拖拽/粘贴**（官方 `ui-attachment` 插件：投放遮罩、缩略图栏、原图灯箱），但它的 README 明确把非图片格式列为待办：

> **Images only** — non-image files have no rail card or history renderer yet.

于是现实是：拖一个 PDF 进对话框，什么都不会发生。而"把文档丢给 AI 读、并就文档提问"是这个产品最常用的场景之一（对标 DeepSeek 网页版）。

**目标**：

1. 能直接拖入 / 粘贴 **PDF、Word、PowerPoint** 文档；
2. agent 能**读到正文**，并**依据提问在文档中定位、组织出带页码/块号引用的答案**；
3. **在任何工作区、任何会话都能用**（不是某个 agent preset 的专属能力）；
4. 以**插件**形式实现，不改 DSH 本体。

**最终形态的关键取舍**：不建向量库、不做 RAG。DSH 的 agent 本身就是 LLM——**理解与组织答案归模型，插件只负责提供精准的检索原语**：

```
document_outline  先看全貌（规模 + 标题大纲），决定读哪里
document_search   按关键词/正则定位，返回块号 + 上下文 + 所属标题
document_read     精读某一段窗口，带位置标注可引用
```

一个 53 页论文绝不能整篇倾倒进上下文——既贵又会把答案淹没。`outline → search → read` 才是可用的文档问答。

---

## 2. 插件功能与支持格式

### 2.1 格式矩阵

| 格式 | 解析方式 | 块（block）单位 | 标题大纲 |
|---|---|---|---|
| `.pdf` | 子进程 + PyPDF2 | 页 | 无 |
| `.docx` | 标准库 `zipfile` + `ElementTree` | 段落 / 标题 / 表格行 | ✅ 经 `styles.xml` 解析 |
| `.doc` | **自研 OLE2/CFB 解析器** | 段落 / 表格行 | 无（标题在 STSHF，未实现） |
| `.pptx` | 标准库 `zipfile` + `ElementTree` | **幻灯片** | ✅ 幻灯片标题占位符 |
| `.ppt` | **自研 OLE2/CFB + 记录树解析** | 文本容器 | 无 |
| `.png` `.jpg` `.jpeg` | **刻意不接** | — | — |

### 2.2 为什么图片不进白名单

图片走 **DSH 自带的图片通道**：拖入即预览、以 image block 发送给模型。

如果本插件把 `.png/.jpg/.jpeg` 列进白名单，它们会被**当作文档存进工作区**，反而**失去预览与原生发送**。所以四份白名单（工具层 / 上传端点 / 浏览器 bundle / Python 后端）**全部排除图片**，并由 `tests/test-extension-consistency.mjs` 强制——任何一份出现 `.png` 即测试失败。

### 2.3 用户看到的行为

1. 把文件拖到页面（或 Ctrl+V 粘贴）
2. 文件落到 `<工作区>/.dsh-drops/`，其**绝对路径被追加到输入框草稿**（形如 `@<工作区>\.dsh-drops\报告.pdf`）
3. 继续打字提问即可；agent 先 outline、再 search 定位、再 read 精读，**带页码/块号作答**

重名不会覆盖：同名文件第二次拖入自动落成 `xxx-1.pdf`。

### 2.4 三个 agent 工具的接口

```
document_outline  { path }
document_search   { path, query, regex?, maxHits?, context? }
document_read     { path, start?, count? }
```

三者共用一个 **block** 概念：PDF 的 block = 页，Word 的 block = 段落/标题/表格行，`.pptx` 的 block = 幻灯片。工具文案会明说当前文件用哪种单位。

---

## 3. 项目结构与关键文件

```
dsh-doc-attach/
├── package.json                    包清单：dsh.bundle / dsh.client / exports / files / peerDependencies
├── cordis.patch.yml                组合层：3 条插件行（关键：必须有裸包名行）
├── install.ps1                     离线安装到 profile（含校验与回滚说明）
├── publish.ps1                     发布脚本（含预检、幂等；需要网络）
├── lib/
│   ├── host.js                     宿主根条目：空 apply()，仅为了让包被识别为客户端包
│   ├── client.js                   浏览器半边：拖拽/粘贴监听、卡片栏、上传、注入 @ 引用
│   └── extract/
│       ├── document_helper.py      格式分派 + extract/search/stats 三种模式（673 行）
│       ├── document-python.mjs     子进程桥接：spawn + 文件交接（不是管道！）
│       ├── doc_reader.py           OLE2/CFB 容器 + 旧版 .doc 的 FIB/片段表
│       └── ppt_reader.py           .pptx 的 OOXML + 旧版 .ppt 的记录树
├── plugins/
│   ├── read-document.mjs           注册三个 agent 工具（宿主平面）
│   └── drop-ingest.mjs             HTTP 上传路由（ctx.webServer.register 前缀路由）
├── tests/                          8 套件（含 2 个 fixture 生成器）
└── .github/workflows/publish.yml   Trusted Publishing（OIDC，无令牌）
```

### 3.1 `package.json` 里与 DSH 相关的字段

```jsonc
{
  "type": "module",
  "main": "./lib/host.js",
  "exports": {
    ".": "./lib/host.js",              // 宿主根条目
    "./client": "./lib/client.js",     // 浏览器 bundle ← dsh.client 要求
    "./plugins/*": "./plugins/*",       // 组合行按子路径解析
    "./lib/*": "./lib/*",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"  // ← 客户端扫描器要靠它归属包
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 本包贡献的组合层
    "client": {                                     // 声明为浏览器插件
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  },
  "files": [ "lib/*.js", "lib/extract/*.mjs", "lib/extract/*.py", "plugins/*.mjs", "cordis.patch.yml", "install.ps1", "README.md", "LICENSE" ],
  "peerDependencies": { "@deepseek-ai/cordis": "*", "@deepseek-ai/dsh-client-ui-conversation": "*" }
}
```

⚠️ **`exports` 是"要么全给要么全不给"的**：一旦写了 `exports`，所有子路径都必须显式列出，否则组合行 `dsh-doc-attach/plugins/x.mjs` 会解析失败。

### 3.2 `cordis.patch.yml` 的三条行

```yaml
- insert:
    # ① 裸包名行：浏览器半边存在的前提（见 §5.1）
    - id: dsh-doc-attach
      name: 'dsh-doc-attach'

    # ② 三个 agent 工具（宿主平面 → 所有工作区可用）
    - id: dsh-doc-attach-tools
      name: 'dsh-doc-attach/plugins/read-document.mjs'
      config: { defaultWindow: 12, maxWindow: 120, maxBlockChars: 12000, timeoutMs: 60000 }

    # ③ 浏览器上传路由
    - id: dsh-doc-attach-drop
      name: 'dsh-doc-attach/plugins/drop-ingest.mjs'
      config: { routePath: /api/doc-attach, dropDirName: .dsh-drops, maxBytes: 67108864 }
```

**为什么放宿主平面而不是 agent preset**：需求是"任何工作区都能用"。preset 是按会话的，放进 preset 就只有用该 preset 的会话有这些工具。

### 3.3 两个入口的形状

**宿主工具插件**（`plugins/read-document.mjs`）：

```js
export const name = 'dsh-doc-attach'
export const inject = ['tools']
export function apply(ctx, config = {}) {
  const { outline, search, read } = buildTools(cfg)
  ctx.effect(() => ctx.tools.register(outline), 'label')
  ctx.effect(() => ctx.tools.register(search), 'label')
  ctx.effect(() => ctx.tools.register(read), 'label')
}
```

**浏览器 bundle**（`lib/client.js`）是**经典脚本**，不是 ES module：

```js
window.__ModuleLoader__.load({
  id: 'dsh-doc-attach',              // 必须等于包名
  factory: function (require) {
    var React = require('react')     // React 从基表取，不能 import
    function DocumentDock(props) { /* ... */ }
    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'dsh-doc-attach',    // ← list 型插槽必须有顶层 id（见 §5.1）
          }, DocumentDock)
        })
      },
    }
  },
})
```

**没有构建步骤**：宿主半边是原生 ESM，浏览器半边是手写经典脚本，Python 直接由解释器执行。

---

## 4. 开发与调试步骤

### 4.1 完整闭环

```text
① 写代码（本地开发副本，无需构建）
② 装进 profile（install.ps1）
③ 重启宿主 + 浏览器 F5
④ 验证 health 端点
⑤ 拖文件实测
```

### 4.2 装进 profile

DSH 的实际部署不在源码 checkout 里，而在**用户的 profile 目录**（本机为 `~/.dsh/profiles/web/`）。第三方插件按**裸包名**从该目录的 `node_modules` 解析。

```powershell
pwsh -File install.ps1 -DryRun   # 只报告，不改动
pwsh -File install.ps1           # 落包 + 注册 bundle
```

脚本做三件事：把包复制到 `<profile>/node_modules/dsh-doc-attach/`、在 profile 的 `package.json` 里加 `dependencies` 与 `dsh.profile.bundles` 条目、校验文件齐全**且退休模块确实不存在**。

⚠️ **不要用 `dsh plugin --profile web remove dsh-doc-attach`** 去"重装"——那会把包整个移除，而重启本身就能重载。本项目期间就因此丢过一次包。

### 4.3 重启宿主（**必须**）

```powershell
# 找到运行中的宿主（Windows）
netstat -ano | Select-String ":3080.*LISTENING"    # 取 PID
Get-Process -Id <PID> | Select-Object StartTime    # 确认启动时间早于你的改动

# 若知道启动终端：Ctrl+C 后重跑
cd <checkout>
pnpm dsh web
```

**为什么必须重启**：见 §5.2。

### 4.4 验证

```bash
curl http://127.0.0.1:3080/api/doc-attach/health
# {"ok":true,"route":"/api/doc-attach","extensions":[".pdf",".docx",".doc",".pptx",".ppt"],...}
```

再加两步实测：**浏览器 F5 刷新**（扩展名白名单在 bundle 里），然后拖一个文件进对话框。

### 4.5 跑测试

```bash
node tests/run-all.mjs              # 全量 109 项 / 8 套件
node tests/run-all.mjs --portable   # 只跑 4 套可移植的（CI 用）
node tests/test-ppt-format.mjs      # 单套
```

**4 套不可移植的原因**：`tests/fixture.mjs` 里的 PDF 样本是本机固定路径，Office 的 `.doc`/`.ppt` 样本来自安装目录。CI 里跑它们必然失败，而失败原因与代码无关——所以用 `--portable` 显式标记这个区别，而不是靠记忆。

---

## 5. 踩坑记录与解决方案（重点）

### 5.0 总览

| # | 坑 | 症状 | 根因 | 关键教训 |
|---|---|---|---|---|
| 1 | list 插槽缺 `id` | 插件加载失败，整个 host 起不来 | `register` 的 `id` 必须是**顶层**字段 | 照契约写，别嵌套 |
| 2 | 缺裸包名行 | 宿主工具正常、**浏览器半边静默消失** | 扫描器按 `<条目名>/package.json` 归属包 | 子路径行会被**永久**判为非客户端包 |
| 3 | 改了客户端代码没生效 | 重启才生效，toggle 无效 | ESM 按 URL 缓存 + 插件元数据永不失效 | 改 `dsh.client` 必须重启 |
| 4 | 子进程捕获输出 EPERM | `spawn EPERM` | 沙箱禁止命名管道 | 用 `stdio:'ignore'` + 文件交接 |
| 5 | 写 profile / npm 缓存 EPERM | 拒绝访问 | 沙箱只放行会话工作区 | 需一次性提权，或把缓存指到工作区内 |
| 6 | Word COM 挂起 | 240 秒无响应，残留 WINWORD | 进程无交互式桌面 | 先探测再依赖 |
| 7 | `.docx` 标题大纲为空 | 大纲 0 条 | 样式 ID 是**数字**，名字在 `styles.xml` | 别拿 id 当名字 |
| 8 | `.doc` 小文件解析越界 | `IndexError` | 迷你 FAT 拿**扇区号**当条目用 | 分配表要读扇区**内容** |
| 9 | `.doc` 目录读成空 | `entries=0` | `out[:0]` 把整条链截成空 | 切片边界要想清楚 |
| 10 | `.ppt` 文本找不到 | 抽出 1 块母版文本 | 文本在 **Escher 容器 61453**，不在 `SlideListWithText` | 凭记忆猜格式结构 = 必错 |
| 11 | 改了抽取逻辑但结果没变 | 拿到旧数据 | 缓存键只有 path+size+mtime | 缓存要带**抽取器版本** |
| 12 | 发布包混入 `.pyc` | tarball 多 2 个文件 | **`files` 存在时 `.npmignore` 完全失效** | 用精确 glob，别白名单整个目录 |
| 13 | 白名单四份不同步 | 拖 `.doc` 被浏览器挡掉 | 同一事实声明在四处，互相无法 import | 用测试强制一致 |
| 14 | `npm publish` 连续 403 | 要求 2FA | 令牌权限选错 / 组织权限冲突 / OTP 位数错 | 见 §5.5 |
| 15 | 测试全绿但插件加载失败 | 68 项通过却起不来 | 假注册表**不执行真实契约** | 测试替身要像真的 |

---

### 5.1 插槽与打包契约

#### 坑 1：`list` 型插槽注册必须带**顶层** `id`

**症状**：DSH 启动失败：

```
Failed to load plugins
dsh-doc-attach
failed to apply loader entry 932e024b (dsh-doc-attach): list slot "conversation.input.dock" requires options.id
```

**根因**（源码 `packages/client/ui-slots/src/index.ts:813`）：

```js
case 'list': {
  if (options.id === undefined) throw new Error(`list slot "${options.name}" requires options.id`)
  ...
}
```

而 `ErasedOptions` 里 `id?: string` 是**顶层**字段（与 `name` 平级），**没有** `options` 子对象。

**两次都栽在这**：第一次完全没给 `id`；第二次把它嵌进了 `{ name, options: { id } }`——`options.id` 仍是 `undefined`，报同一个错，但原因不同。

**正确写法**：

```js
ctx.slots.register({ name: 'conversation.input.dock', id: 'dsh-doc-attach' }, Component)
```

**记忆点**：报错说 `requires options.id` 时，"options" 指的是 `register` 的**第一个参数整体**。

#### 坑 2：客户端包**必须有一条裸包名行**

**症状**：宿主工具全正常（health 200、三个工具都在），但**浏览器半边完全不出现**——没有拖拽、没有卡片栏，页面源码里搜不到包名。

**根因**（源码 `packages/client/modules/src/index.ts:434`）：

```js
try { pkgPath = this.resolvePkgJson(pkgName) }   // require.resolve(`${条目名}/package.json`)
catch {
  // … subpath entries (…/gateway) land here — permanently not a client row.
  this.pkgMeta.set(pkgName, null)   // 永久缓存，永不重试
}
```

扫描器用**条目名**去解析 `<条目名>/package.json`。若组合行全是子路径（`dsh-doc-attach/plugins/xxx.mjs`），解析必然失败 → 该包被**永久**记为"非客户端包"。

**正确做法**：加一条**裸包名行**，其宿主条目是个空壳（官方 `ui-attachment` 的根条目就是这么写的）：

```js
// lib/host.js —— 全文
export function apply() {}   // 不做任何事，只为让包被识别为客户端包
```

```yaml
- id: dsh-doc-attach
  name: 'dsh-doc-attach'      # ← 裸包名，不加任何子路径
```

**记忆点**：所有 browser-only 插件包都有一条这样的行，这不是冗余。

#### 坑 3：改了客户端代码必须先重启

- Node 的 ESM 缓存按**解析后的 URL** 缓存，市场面板 toggle 会重新 `import()` **同一个 URL** → 拿到的还是旧模块
- 客户端包元数据"按名缓存且**永不过期**"，插件集变更要重启才生效

**排查手法**：如果旧文案在**磁盘源码里已经搜不到**、但运行时仍在输出，那就是进程内存里持有旧模块 → **只能重启**，别在 toggle 上耗时间。

### 5.2 沙箱与环境限制

#### 坑 4：子进程捕获输出必然 EPERM

```js
execFile(python, args, cb)   // → spawn EPERM（同步抛出）
```

受限沙箱下**子进程无法开命名管道**，所以任何用 `stdio:'pipe'` 捕获子进程输出的写法都失败。

**解法**：`spawn` + `stdio: 'ignore'` + **结果写文件再读回**。

```js
const child = spawn(python, [...args, '--out', outPath], { stdio: 'ignore', windowsHide: true })
// 退出后 readFileSync(outPath)
```

附带收益：**没有 stdout 缓冲上限**，大文档不会截断。诊断信息也让 helper 自己写进 `--log` 文件，因为 stderr 没人接。

#### 坑 5：写工作区之外的文件被拒

| 目标 | 结果 |
|---|---|
| `~/.dsh/profiles/web/`（装插件） | EPERM，需一次性提权 |
| `~/.modlens/config.json`（改配置） | EPERM |
| `%LOCALAPPDATA%\npm-cache`（npm pack） | EPERM |

**可避免的那一个**：npm 缓存路径可以用参数改到工作区内，不必提权：

```powershell
npm pack --dry-run --cache <项目根目录>\.npm-cache
```

#### 坑 6：Word COM 在本机挂起

为了让 `.doc` 走"转成 `.docx` 再读"的省事路线，试了 Word COM 自动化：**240 秒超时**，`New-Object -ComObject Word.Application` 就没有返回，还残留了一个 WINWORD 进程需要清理。

**根因**：进程没有交互式桌面，Office COM 自动化会永久等待。

**教训**：外部依赖（尤其是 COM / 需要桌面的东西）**必须先写探测脚本验证再依赖**。这条探测省下了"实现完才发现跑不通"的代价。

#### 坑 7 与 8：两个 Windows 命令陷阱

```powershell
# ① -Filter 按 8.3 短名语义匹配：*.doc 会连 *.docx 一起命中
Get-ChildItem -Filter *.doc          # ❌ 拿到一堆 .docx，得到 57 个假失败
Get-ChildItem | Where-Object { $_.Extension -eq '.doc' }   # ✅ 显式判断

# ② -Recurse 遇 node_modules 里的嵌套 junction 会卡死/报错
Get-ChildItem -Recurse               # ❌ 大量 IOException
fast_locate / glob                   # ✅ 自动跳过噪音目录
```

#### 坑 9：PowerShell 不支持 bash heredoc

```powershell
git commit -F - <<'MSG'      # ❌ PowerShell 里 '<' 是保留操作符，整段脚本解析失败
```

**解法**：PowerShell here-string。

```powershell
$msg = @"
subject

body
"@
git commit -m $msg
```

### 5.3 文档解析器的坑

#### 坑 10：`.docx` 标题大纲为空（样式 ID 是数字）

**症状**：一份结构清晰的中文方案文档，`document_outline` 返回 **0 条标题**。

**根因**：`w:pStyle` 的值是**样式 ID，不是样式名**。该文档的 ID 是纯数字，名字在 `styles.xml` 里：

```
w:pStyle val="2"  → styles.xml: styleId=2  name="heading 1"   (22 处)
w:pStyle val="14" → styles.xml: styleId=14 name="List Paragraph"
w:outlineLvl      → 全文无
```

WPS 及部分导出器普遍如此。拿 `val="2"` 去匹配标题正则当然匹不到。

**解法**：`pStyle` → 查 `styles.xml` 取 **name**，并沿 `basedOn` 链解析（自定义样式可能派生自 `heading 1`）。同时支持段落自带的 `w:outlineLvl`（权威信号）。

**测试守住了它**：fixture 生成器 `tests/make-docx-fixture.py` **刻意使用数字 styleId**，复刻这个陷阱。

#### 坑 11：`.doc` 的迷你 FAT —— 分配表要读扇区**内容**

**症状**：大 `.doc` 解析正常，某个小文件 `IndexError`。

**根因**：CFB 里 < 4096 字节的流存在**迷你流**中，需要迷你 FAT。我把 `_chain()` 返回的**扇区号列表**当成了分配表**条目**：

```python
self._minifat = self._chain_ints(self.first_minifat, ...)   # ❌ 这是扇区号
```

于是迷你链第一步就走到垃圾值、提前结束，流被读短，深层越界。

**解法**：读每个扇区的**内容**再解包成条目。

```python
def _read_table(self, first_sector, num_sectors):
    entries = []
    for sector in self._chain(first_sector):
        entries.extend(struct.unpack_from(f"<{self.sector_size // 4}I", self._sector(sector), 0))
    return entries
```

**这个坑只有真实文件能暴露**——大文件走普通扇区所以正常，小文件才走迷你流。

#### 坑 12：`out[:0]` 把整条链截成空

```python
return bytes(out[:size])    # ❌ 读目录时传 size=0 → 返回空 → entries=0
return bytes(out) if size == 0 else bytes(out[:size])   # ✅ 约定 0 = 不截断
```

目录链自身没有长度字段，必须靠"0 表示整条链"这个约定。

#### 坑 13：`.ppt` 文本不在 `SlideListWithText` 里

**症状**：想按"幻灯片边界"分组，结果 208 块被揉成 **1 块母版文本**（"Click to edit Master title style"）。

**根因**：我**凭记忆猜**格式结构，以为 `SlidePersistAtom(1011)` 是幻灯片边界。dump 真实记录树后发现：

```
文本原子的直接父类型：61453 x289、5002 x81、4044 x7、1016 x2
SlideListWithText instances: {1:1, 0:1, 2:1}   ← 只装 SlidePersistAtom，没有文本
```

**文本在 Escher 绘制容器（type 61453）里**，`SlideListWithText` 只存幻灯片索引。

**解法**：按文本容器分组。并且——**既然无法可靠映射回真实幻灯片号，就不该声称"slide N"**。最终 `.ppt` 的单位标为 **block**，不谎报页号。

**教训**：解析任何结构化/二进制格式前，**先 dump 真实结构**。而且不要把自己的 dump 输出用 `Select-Object -First N` 截断——我第一次就是这么把唯一能回答问题的汇总段切掉的。

#### 坑 14：缓存必须带抽取器版本

缓存键原本只有 `path + size + mtime`。**改了抽取逻辑却仍返回旧结果**——键没变，缓存命中。

**解法**：把 `CACHE_VERSION` 编进键，抽取逻辑变更时手动递增。

```python
CACHE_VERSION = 3
raw = f"v{CACHE_VERSION}|{abspath}|{size}|{mtime_ns}"
```

#### 坑 15：读取器产出的字段被中间层丢掉

`.pptx` 的读取器在 block 上写了 `slide`/`title`，但 helper 的 `mode_extract` 只转发白名单字段：

```python
for extra in ("level", "row", "warning"):    # ❌ 丢掉了 slide / title
```

结果幻灯片号与标题在 helper 层就没了，测试报"顺序不对"。

**解法**：新增字段时**同步改转发白名单**。

#### 坑 16：单位词表按错维度做键

```js
const UNIT_WORD = { pdf: '页', block: '块', slide: '页' }   // ❌ 键是【格式】
// 后端返回的 unit 是 'page' / 'block' / 'slide' → UNIT_WORD['page'] 未定义 → 退化成 '块'
const UNIT_WORD = { page: '页', block: '块', slide: '页' }  // ✅ 键是【单位】
```

所有 PDF 都被写成"53 块"而不是"53 页"。**这是测试抓出来的**，不是我自己看出来的。

### 5.4 测试与验证的坑

#### 坑 17：测试全绿，插件却加载失败

当时 68 项测试全通过，但插件**根本起不来**（就是 §5.1 的坑 1）。原因：测试里的 slots 替身**过于宽松**，来者不拒，从不执行真实契约。

**解法**：让替身**按真实源码逐类型校验**（list 必须有顶层 id、重复 `(id, priority)` 抛错），并把"嵌 `options: { id }`"这种错法写成显式用例钉死。

**原则**：测试替身若不可能失败，它比没有测试更糟——它会给出一份看起来有证据的错误信心。

#### 坑 18：一个不可能失败的检查

```powershell
Select-String -Pattern 'a|b|c' -SimpleMatch    # ❌ -SimpleMatch 把 | 当字面量
```

这条检查**永远不可能命中**，我却据此得出"无残留引用"的结论——**结论是错的**，实际有 3 处引用指向已删除的模块。

**教训**：断言"不存在"的检查，**必须先验证它会失败**（拿一个已知阳性样本试一次）。

#### 坑 19：断言依赖了作者环境的假设

- 用拉丁字母 `e` 当检索词，假设"任何文档都含 e" → 纯中文表格文档直接失败
- 用本机固定路径的 PDF 当样本 → 换台机器全挂

**解法**：**测试数据从数据本身取**（如取文档首个字符当检索词），环境相关资源显式参数化或优雅跳过。

#### 坑 20：功能增强会作废旧断言

支持 `.pptx` 后，3 条断言（"pptx 未实现所以要拒绝"）失效。这不是缺陷，是断言过期。

**正确做法**：**改写断言而非删除**——把"未实现的容器应被拒绝"改为针对真正没有读取器的格式（`.xlsx`），保留原意（拒绝必须点名格式）同时跟上事实。

### 5.5 发布相关的坑

#### 坑 21：`.npmignore` 在 `files` 存在时**完全失效**

`files: ["lib/"]` 把整个目录白名单，于是 `lib/extract/__pycache__/*.pyc` **进了发布包**。

危害不只是脏：**陈旧字节码可能被 Python 优先加载**，导致装了新源码却跑旧逻辑。

**解法**：改用**精确 glob**（`lib/extract/*.py`）——因为 `__pycache__` 每次运行都会再生，靠删除无效。

**并且 `__pycache__` 不是 git 追踪的**（`.gitignore` 挡住了），但 **npm 是从工作目录打包的**，未跟踪文件照样进包。

#### 坑 22：npm 令牌的三种失败

| 尝试 | 报错 | 根因 |
|---|---|---|
| `publish and stage` 未选，选了 `stage only` | 403 要求 2FA | **`stage only` 令牌不能直接发布**，只能暂存待维护者批准 |
| 组织权限设为 `Read and write` 但没选组织 | `You must select at least one organization if granting organization permissions` | 两个独立字段：**权限级别**要设 `No access`，不是只清空组织列表 |
| `--otp=<8位码>` | `EOTP` | npm 的 TOTP 是 **6 位**；且**不要写尖括号**（那是占位符） |

**能直接发布的正确配置**：Permissions = `Read and write (publish and stage)` + 勾 **Bypass two-factor authentication** + Organizations 权限 `No access` + Packages `All packages`。

#### 坑 23：Trusted Publishing（推荐，且已在本项目落地）

令牌有寿命（30 天过期，且 npm 宣布 **2027 年 1 月移除令牌直接发布**）。OIDC 是替代方案：**无长期密钥、无需处理 2FA**。

**四个必须同时对上的前提**：

| 前提 | 具体值 |
|---|---|
| workflow 权限 | `permissions: { contents: read, id-token: write }` |
| npm CLI 版本 | **≥ 11.5.1**（Node 22 自带 npm 10，**不够**；用 Node 24） |
| npm 网页配置 | Trusted Publisher → Organization/user、Repository、**Workflow filename 逐字匹配**（`publish.yml`）、Environment 留空 |
| **Allow npm publish** | 表单里必须勾选！否则只允许 `npm stage publish`（暂存），而 workflow 用的是 `npm publish` |

**不要写 `npm ci`**：零依赖包没有 `package-lock.json`，会立刻失败。

#### 坑 24：CI 跑不了全量测试

测试依赖开发机的固定 fixture（真实 PDF、Office 样本）。**解法**：`run-all.mjs --portable` 显式标记可移植子集，让"哪些能在 CI 跑"成为仓库里的**事实**而非记忆。

---

### 5.6 关于「端口 3080 被占用」——一件事先澄清

**EADDRINUSE 在本项目的开发过程中没有实际发生。** 我没有把它写进踩坑记录，因为编造经历比漏写更糟。

本机实际遇到的是与"宿主进程"有关的这些事实：

- 宿主监听 `127.0.0.1:3080`，**一个端口只能有一个宿主**
- 确认宿主身份与启动时间（判断是否已重载过新代码）：
  ```powershell
  netstat -ano | Select-String ":3080.*LISTENING"
  Get-Process -Id <PID> | Select-Object Name, StartTime
  ```
- 本机**取不到进程命令行**：`Get-CimInstance Win32_Process` 被拒、`wmic` 无输出、`dsh` 不在 PATH。最终是靠 **PowerShell 命令历史**（`ConsoleHost_history.txt`）才找到启动方式 `cd <checkout>; pnpm dsh web`
- 如果确实需要换端口，DSH 的 webserver 有 `host`/`port` 配置（`127.0.0.1` | `0.0.0.0`），Web 组合的 patch 层里有 `webserver` 行可以覆盖

**如果你确实另遇到过 EADDRINUSE**，请告诉我当时的报错与场景，我按事实补进本节。

---

## 6. 可复用的代码片段与命令

### 6.1 注册浏览器 Slot（含 list 型必需 id）

```js
window.__ModuleLoader__.load({
  id: '<package-name>',
  factory: function (require) {
    var React = require('react')
    function MyEntry(props) {
      // props: sessionId, useInput, inputActions, session, input（会话标准工具包）
      return React.createElement('div', null, 'hello')
    }
    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register(
            { name: 'conversation.input.dock', id: '<package-name>' },   // id 必需且顶层
            MyEntry,
          )
        })
      },
    }
  },
})
```

可选槽位（按用途挑，别抢 `single` 型的 `conversation.input.attachments`）：

| 槽位 | 类型 | 适合放什么 |
|---|---|---|
| `conversation.input.dock` | list | 需要**独占一行、可点击**的内容（本项目用它放状态行） |
| `conversation.composer.dock` | list | 卡片下方的**环境读数**（文档说需要点击的东西不该放这） |
| `conversation.input.left` / `.right` | list | 工具行里的一行小控件 |

### 6.2 注册 agent 工具（宿主平面）

```js
export const inject = ['tools']
export function apply(ctx, config = {}) {
  ctx.effect(() => ctx.tools.register({
    name: 'my_tool',
    description: '给模型看的用法说明（模型靠它决定何时调用）',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) { return '结果文本' },
  }), 'label')
}
```

### 6.3 子进程桥接（沙箱安全版）

```js
const child = spawn(python, [
  helperPath, ...helperArgs,
  '--out', outPath,     // 结果写文件
  '--log', logPath,     // 崩溃 traceback 写文件
], { stdio: 'ignore', windowsHide: true })   // ← 不能是 pipe

child.on('close', (code) => {
  try { resolve(JSON.parse(readFileSync(outPath, 'utf8'))) }
  catch { reject(new Error(`exit ${code}, read ${logPath}`)) }
})
```

### 6.4 自注册 HTTP 路由（绕过 Typert 生成契约）

暴露宿主方法给浏览器**常规**要走 Typert `@Remote` + 构建期生成的投影，而可挂载的集合由**已发布的 `dsh-web-app` 在构建期定死**——第三方插件加不进去。`ctx.webServer.register` 是通用路由表：

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'prefix',                 // 匹配 p 及 p/<anything>
  path: '/api/my-plugin',
  handler: async (req, res) => { /* 自己掌控整个响应生命周期 */ },
}), 'label')
```

### 6.5 常用命令

```powershell
# ── 定位实际部署（不在源码 checkout，而在 profile）
$profile = "$env:USERPROFILE\.dsh\profiles\web"
Get-Content "$profile\package.json"       # dsh.profile.bundles 列出所有 bundle

# ── 安装 / 重装
pwsh -File install.ps1 -DryRun
pwsh -File install.ps1

# ── 找宿主并重启
netstat -ano | Select-String ":3080.*LISTENING"
Get-Process -Id <PID> | Select-Object StartTime
# 然后在原终端 Ctrl+C，重跑：
cd <checkout>; pnpm dsh web

# ── 验证
curl http://127.0.0.1:3080/api/<plugin>/health

# ── 测试
node tests/run-all.mjs
node tests/run-all.mjs --portable

# ── 打包内容自检（不需要网络）
npm pack --dry-run --cache .\.npm-cache
```

### 6.6 开源发布流程（本项目实际执行的顺序）

```powershell
# 1) 本地仓库（含 LICENSE / .gitignore / .npmignore / .gitattributes）
git init -b main
git config user.name  "<你的 GitHub 用户名>"                                  # 仓库级，不动全局
git config user.email "<用户名>@users.noreply.github.com"
git add -A ; git commit -m "feat: ..."
git tag -a v0.1.0 -m "v0.1.0 - first public release"

# 2) 建远程仓库（两种方式）
gh repo create <user>/<repo> --public --source=. --remote=origin --push      # 需装 gh
# 或用网页 https://github.com/new 建空仓库后：
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
git push origin v0.1.0

# 3) 打包自检（重要：能抓出发货内容问题）
npm pack --dry-run

# 4) 发布（一次性手动）
npm login                                   # 浏览器授权那步直接按回车
npm publish --access public                 # 需 2FA；或用授权令牌

# 5) 之后走 OIDC 自动化
npm version patch
git push --follow-tags                      # 触发 .github/workflows/publish.yml
```

---

## 7. 最佳实践与检查清单

### 7.1 开发前

- [ ] **确认实际部署位置**：DSH 的第三方插件从 **profile 的 node_modules** 解析，不是源码 checkout
- [ ] **先读契约再写代码**：插槽的 `kind`、注册参数、包声明要求都在 `packages/` 源码里，别凭印象
- [ ] **外部依赖先探测**：COM / 外部命令 / Python 库**先写探测脚本验证**，再决定是否依赖

### 7.2 写代码时

- [ ] 浏览器半边是**经典脚本**：不能 `import`、不能 JSX、React 走 `require`
- [ ] `list` 型插槽的 `id` 是**顶层**字段
- [ ] 包必须有一条**裸包名行**，其宿主条目为空 `apply()`
- [ ] 一旦写 `exports`，所有子路径都要显式列出
- [ ] **新增/删除字段时同步改转发层**（helper 的白名单、投影）
- [ ] **删除常量时全仓 grep 引用**
- [ ] 缓存键带上**抽取器/逻辑版本**

### 7.3 测试时

- [ ] **测试替身要执行真实契约**，否则全绿也可能加载失败
- [ ] 断言"不存在"的检查，**先用已知阳性验证它会失败**
- [ ] 测试数据**从数据本身取**，别依赖作者环境的假设
- [ ] 环境相关 fixture：**参数化或优雅跳过**，并在 CI 用 `--portable` 显式区分
- [ ] 功能增强后**改写**过期断言，别删除

### 7.4 打包与发布时

- [ ] `npm pack --dry-run` **必看**（`files` 存在时 `.npmignore` 失效）
- [ ] `files` 用**精确 glob**，不要白名单整个目录
- [ ] `peerDependencies` 指向 `@deepseek-ai/*` 时用 `"*"`，避免与实际版本打架
- [ ] 版本号与 tag 必须一致（CI 里加守卫）
- [ ] OIDC 四前提：`id-token: write` / npm ≥ 11.5.1 / workflow 文件名逐字匹配 / **勾 Allow npm publish**
- [ ] 零依赖包**不要写 `npm ci`**（无 lockfile）
- [ ] **令牌不要贴进对话**；一旦贴出即视为泄露，用完立刻撤销

### 7.5 排查问题时

- [ ] 旧文案在磁盘源码里已不存在、运行时仍输出 → **进程内存持有旧模块** → 重启，别试 toggle
- [ ] Windows：`-Filter` 走 8.3 语义（`*.doc` 会命中 `.docx`）；`-Recurse` 遇 junction 会炸
- [ ] 结构化/二进制格式：**先 dump 真实结构**，且**不要把 dump 管道进截断命令**
- [ ] PowerShell 没有 heredoc，用 `@"..."@`
- [ ] 断言失败先分清是**产品缺陷**还是**断言过期**——两者处置完全不同

---

## 8. 后续改进方向

按"价值 / 成本"排序：

| # | 方向 | 说明 | 成本 |
|---|---|---|---|
| 1 | **OCR** | 扫描件 PDF、纯图片页现在会明确报"无文本层"而不是静默返回空。接入 OCR（或走视觉模型）可以覆盖这类文档 | 中 |
| 2 | **`.doc` 标题大纲** | 旧格式标题信息在样式表 **STSHF** 里（不是 `styles.xml`），未解析 | 中 |
| 3 | **`.ppt` 真实幻灯片号** | 需把绘制树与 slide-persist 记录做关联；现在诚实地只报 block | 中高 |
| 4 | **Excel `.xlsx/.xls`** | 同属 OOXML，`.xlsx` 可用 `zipfile` + `sharedStrings.xml` 实现；表格类文档检索价值高 | 低中 |
| 5 | **`.doc` 压缩片段的真实样本** | 8-bit 片段分支已实现但**无真实样本覆盖**（中文文档不产生该分支） | 需样本 |
| 6 | **错误提示优化** | 让"不支持的格式"提示直接给出**可操作建议**（如"请另存为 .docx"） | 低 |
| 7 | **卡片栏 UI** | 当前是"状态行 + 把路径注入草稿"的极简做法；可做成 DeepSeek 网页版那样的文件卡片列 | 中 |
| 8 | **桌面 Electron 支持** | 现在仅 Web GUI 可用（Electron 走 `file://` + IPC，不经此 HTTP 路由） | 中高 |
| 9 | **页面/块级缓存预热** | 首次检索要抽取全文；可在落盘后后台预热缓存 | 低 |
| 10 | **`publish.ps1` 放宽 gh 守卫** | 用网页建仓库的人会因缺 `gh` 而在 npm 之前中止 | 低 |

---

## 附：需要补充的信息

以下信息本项目无法自行确定，欢迎补充后并入正文：

1. **「端口 3080 被占用 / EADDRINUSE」**：本项目**未发生**。如果你另遇到过，请给出报错原文与场景，我补进 §5.6。
2. **真实用户规模与反馈**：发布后是否有人实际安装使用、遇到什么问题——可补进 §8 作为优先级依据。
3. **`.doc` 压缩片段样本**：如果你手上有纯英文/拉丁文的旧 `.doc`，可能正好覆盖那段未验证的分支。
4. **`gh` CLI 的发布路径**：本项目最终用**网页建仓库 + git 推送**（因为 `gh` 未安装），`gh repo create` 那条命令是**文档化但未实测**的路径。
5. **Node 20 弃用警告的处理**：`actions/checkout@v4` / `actions/setup-node@v4` 触发该警告，建议升 v5；但作者环境无网络**无法确认 v5 已发布**，故未改动正在工作的 workflow。
