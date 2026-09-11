[![CI](https://github.com/ghostflyby/infinmonkey/actions/workflows/ci.yml/badge.svg)](https://github.com/ghostflyby/infinmonkey/actions/workflows/ci.yml)

# 🐵 InfinMonkey

用户脚本（userscript）与用户样式（userstyle）管理器和运行时，目标平台 **Manifest V3**， 支持 Chrome
/ Firefox（含 Zen）/ Safari，使用 **Deno** 作为工具链，`webextension-polyfill` 统一 API。

## 特性

- **MV3 运行时**：runner 以 `world: "MAIN"` 内容脚本形式由 manifest 直接声明（Firefox 128+ / Chrome
  111+）， 用户脚本运行在页面上下文，`unsafeWindow` 即页面 `window`，不受页面 CSP/Trusted Types
  影响（带 TT 兜底策略）。
- **GM API 全套**（按 `@grant` 白名单注入）：
  - 存储：`GM_getValue / GM_setValue / GM_deleteValue / GM_listValues`（同步，TM/VM 惯例）+
    `GM_addValueChangeListener / GM_removeValueChangeListener`，跨标签页变更广播
  - 网络：`GM_xmlhttpRequest`（跨域、超时、中止、arraybuffer、`@connect` 严格授权）
  - 其他：`GM_addStyle`、`GM_registerMenuCommand`、`GM_setClipboard`、`GM_notification`、
    `GM_openInTab`、`GM_download`、`GM_getTab / GM_saveTab / GM_getTabs`、`GM_getResourceText / GM_getResourceURL`
  - GM4 点式别名：`GM.getValue`、`GM.xmlHttpRequest`、`GM_info` 等
- **用户样式**：Stylus 惯例 `/* ==UserStyle== */` 头 + `@-moz-document domain/url-prefix/url/regexp`
  作用域； 作用域在 background 解析后按 URL 条件注入，Chromium/Safari
  同样生效；样式保存后**免刷新即时生效**。
- **本地文件映射调试**（核心特性，纯 web 实现，无需 native messaging）：
  - `deno task devserver` 起本地服务（文件监听 + WebSocket 推送）
  - 脚本/样式可映射到 `http://127.0.0.1:<port>/xxx.user.js`，注入时实时拉取最新代码
  - 样式保存免刷新生效；脚本可自动刷新命中页面
  - 后续 native messaging 可作为同一协议的传输层替换
- **安装流**：访问 `.user.js` / `.user.css`（或带头的纯文本页）出现安装横幅 →
  元数据确认页（授权/匹配/来源预览）→ 安装； 支持从 URL
  安装、重复安装去重、手动检查更新（`@updateURL` / `@downloadURL`）
- **管理界面**：options 面板（列表 / 编辑器 / 导入导出 / dev 映射设置）、popup（本页生效列表 +
  菜单命令）、 `@connect` 授权弹窗（仅此一次 / 永久允许 / 拒绝，可在编辑器里撤销）

## Lint 插件与未使用导出检测

- `deno lint` 已接入自制插件（`lint.plugins` → `packages/tools/lint-plugin.ts`）： 规则
  `no-leaf-exports` 强制 `content/`、`inject/` 叶子 bundle 零导出（它们被 manifest
  直接声明为独立入口，导出只可能是错误或死代码）；
- 跨文件的未使用导出检测不在 lint 插件能力范围内（插件按文件遍历报告、缺少 全部文件处理完的 finalize
  钩子），由独立任务承担：`deno task unused`。

## 快速开始

```bash
# 构建（firefox + chrome → dist/<browser>）
deno task build

# 启动本地映射服务（默认 127.0.0.1:17321，serving examples/）
deno task devserver --dir ./examples

# 构建 + 在配置的浏览器中以临时方式加载扩展（默认 zen）
deno task run
deno task run --browser nightly   # 临时指定
```

## 浏览器配置（本地文件，已 gitignore）

解析优先级：`--browser <名>` > 环境变量 `INFIN_BROWSER` > `.browsers.local.json` 的 `default` > 内置
`zen`。

创建 `.browsers.local.json`（不会被提交）即可指向任意 Firefox 系浏览器：

```json
{
  "default": "nightly",
  "browsers": {
    "nightly": {
      "binary": "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
      "profile": ".webext/nightly-profile",
      "args": ["--devtools"]
    }
  }
}
```

- `profile` 缺省为 `.webext/<名字>-profile`；`args` 经 web-ext 的 `--` 透传给浏览器；
- `deno run -A packages/tools/browsers.ts` 直接打印解析结果；
- E2E 遵循同一配置：`deno run -A packages/tools/e2e.ts --browser <名>`；
- 未安装的路径会给出友好报错并提示检查本地配置。

`run:zen` 等价于 `run --browser zen`。web-ext 通过 `deno run -A npm:web-ext@10.6.0` 调用 （`deno x`
在本项目配置下无法解析其传递依赖，`deno run` 走常规模块加载器则正常）。

## Chromium 系支持（实验性）

内置 `edge` / `chrome` / `chromium` 条目（kind 自动推断，也可显式声明 `"kind": "chromium"`）：

- **装载**（`deno task run --browser <名>`）：直接以 `--load-extension=<dist/chrome>` 启动浏览器，
  一次性实例，无 web-ext 式自动重载；
- **E2E**（`deno run -A packages/tools/e2e.ts --browser <名>`）：走 chromedriver
  （`.webext/drivers/chromedriver` 优先，否则 PATH）；
- **限制**：品牌版 Chrome/Edge 稳定通道会忽略 `--load-extension`（官方 2025 起的政策）， 实测 Edge
  152 确实不装载扩展。要在 Chromium 系上真正开发/跑 E2E，需要无品牌构建 （Chromium 或 Chrome for
  Testing）+ 同大版本 chromedriver，二者版本精确配对； 本仓库不代下载浏览器，请自行放置后通过
  `.browsers.local.json` 指向。

## 验证

```bash
deno task test          # 单元测试（元数据解析 / 匹配器 / mozdoc / 版本比较）
deno run -A packages/tools/e2e.ts  # 端到端：geckodriver 驱动 Zen 无头实例，18 项断言
```

E2E 覆盖：临时安装扩展 → 安装横幅 → 确认页 → MAIN world 注入 → GM 存储/addStyle/xmlhttpRequest/
剪贴板/@connect 授权弹窗 → dev 映射热更新 → 用户样式作用域注入。
前置条件：`deno task build:firefox`、`deno task devserver`、`brew install geckodriver`。

## 目录结构（Deno workspace，按 JS 运行上下文划分子项目）

```
packages/
  shared/      @infinmonkey/shared    lib: esnext+webworker+dom —— 元数据解析、匹配器、mozdoc、协议（跨上下文复用）
  background/  事件页/SW              lib: esnext+webworker      —— 存储、注入调度、@connect、GM_xhr、dev client
  content/     内容脚本（隔离世界）    lib: esnext+dom            —— bridge 桥、安装横幅
  inject/      MAIN world 运行时      lib: esnext+dom            —— runner、GM API 实现
  ui/          扩展页面               lib: esnext+dom            —— options/popup/install/prompt
  tools/       Deno CLI 工具          lib: esnext+deno.window    —— build、dev_server、e2e
  tests/       单元测试               lib: esnext+deno.window    —— 共享层测试
```

每个成员的 `deno.json` 声明各自的 `compilerOptions.lib`，类型检查即拒绝越界引用 （background 引
`document`、shared 引 `Deno` 都会直接报错，见各成员 deno.json）。 依赖版本集中在根 `deno.json` 的
`imports` 管理，成员以 `workspace:*` 引用 shared。

**依赖说明**：`deno.json` 设置 `nodeModulesDir: "none"`，项目内**没有 node_modules、没有 vendored
依赖**—— 打包用 `deno bundle`（oxc 内核，TS 直打包），npm 依赖（`webextension-polyfill`）由 Deno
全局缓存解析， esbuild 已从工具链移除。升级依赖只需改 `deno.json` 里的版本号。

## Safari

```bash
deno task safari:convert   # 用 xcrun safari-web-extension-converter 生成 Xcode 工程
```

Safari 需在「设置 → 扩展」中手动允许，并注意：Safari 对 `scripting` 的 `world: "MAIN"` 支持
与部分权限有差异，未列入一期验证目标。

## 已知限制 / 内核问题备忘

实测 Zen（Firefox 内核 MV3 事件页）存在若干缺陷，已做兜底：

1. 内容脚本消息的 `sender` 缺失 `tab`/`frameId` → 注入改为 manifest 声明 MAIN world runner，
   不再依赖 background 解析调用方位置；
2. 事件页里 `tabs.query({})` 返回空（扩展页面上下文正常）→ 菜单命令/通知的 tab 定位降级为
   `tabs.onUpdated` URL 日志的尽力而为匹配；
3. 事件页闲置挂起后，对扩展页面消息的唤醒不可靠 → 内容脚本 20s 心跳维持存活 + 页面侧消息超时重试
   （`CreateEntry` 带幂等令牌防止重试造重）；
4. `webNavigation.onCommitted` 在事件页挂起期间不送达（样式已改为 runner 侧 `<style>`
   同步，不依赖它）。

其他限制：`GM_xmlhttpRequest` 的 `FormData` 会被表单编码；`@resource` 二进制资源未支持；
脚本自动更新为手动触发；iframe 中注册的菜单命令在 popup 中按 tab 维度展示。

## 权限说明

`storage` `unlimitedStorage` `scripting` `tabs` `webNavigation` `notifications` `downloads`
`clipboardWrite`

- `<all_urls>` 主机权限（跨域请求与全站注入所需，严格 `@connect` 授权控制实际外发）。

## 许可证

本项目以 [MPL-2.0](LICENSE) 发布：文件级 copyleft——扩展本体源码保持开放、修改可追溯，
同时与全部分发渠道（AMO / Chrome Web Store / iOS・macOS App Store）兼容。

运行时打包的第三方组件 `webextension-polyfill` 同为 MPL-2.0（许可随包内附于 `LICENSE`）；
构建工具链（Deno、@std/*、web-ext、chromedriver/geckodriver）仅为开发依赖，不随扩展分发。
`examples/` 下的示例脚本与项目同许可。

## CI

`.github/workflows/ci.yml`，三个 job：

- **static**：fmt / lint / check / 单元测试 / 未使用导出检测 / 构建（dist 作为 artifact）；
- **e2e-firefox**：ubuntu runner 预装 Firefox + geckodriver，`deno task devserver` 后台 + 全量 E2E；
- **e2e-chromium**：`setup-chromium.ts` 从 Chrome for Testing 下载钉死 known-good 版本的 Chrome +
  chromedriver（CI 一次性环境的标准做法，规避品牌版 `--load-extension` 政策），跑同一套 E2E。

失败时上传 `.e2e/` 截图与现场。Safari 需人工在系统设置中启用扩展，暂不进 CI（见上方限制说明）。
