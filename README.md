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

- `deno lint` 已接入自制插件（`lint.plugins` → `packages/tools/lint-plugin.ts`）：
  规则 `no-leaf-exports` 强制 `content/`、`inject/` 叶子 bundle 零导出（它们被 manifest
  直接声明为独立入口，导出只可能是错误或死代码）；
- 跨文件的未使用导出检测不在 lint 插件能力范围内（插件按文件遍历报告、缺少
  全部文件处理完的 finalize 钩子），由独立任务承担：`deno task unused`。

## 快速开始

```bash
# 构建（firefox + chrome → dist/<browser>）
deno task build

# 启动本地映射服务（默认 127.0.0.1:17321， serving examples/）
deno task devserver --dir ./examples

# 在 Zen 浏览器加载扩展（临时安装，自动重载）
deno task run:zen
```

`run:zen` 通过 `deno run -A npm:web-ext@10.6.0` 驱动 Zen（`/Applications/Zen.app`）。

> 注：`deno x` 在本项目配置下无法解析 web-ext 的传递依赖（其缓存安装布局的已知问题）， `deno run`
> 走常规模块加载器则一切正常，故采用后者。

## 验证

```bash
deno task test          # 单元测试（元数据解析 / 匹配器 / mozdoc / 版本比较）
deno run -A tools/e2e.ts  # 端到端：geckodriver 驱动 Zen 无头实例，18 项断言
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
