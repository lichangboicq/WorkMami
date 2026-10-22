# 维护说明（本机长期维护基线）

> 本文件只记录本仓库相对上游的**本地定制**与**本机构建/部署闭环**，上游通用说明见 README.md。
> 仓库位置：`C:\Users\Administrator\Documents\workmami`（git 仓库，分支 `main`）。

## 1. 仓库定位

基于上游开源项目 **majiabin2020/WorkMami**（Tauri 2：Rust 后端 + React/AntD 前端）的本地长期维护分叉。源码最初经 GitHub API 逐文件下载，**不是 `git clone`，故本地从未带上游 `.git`（无上游提交历史）**；本仓库为 `git init` 新建。

### 1.1 上游仓库现状（2026-10-21 经 api.github.com 核实）
- 原仓库 `majiabin2020/WorkMami` 已 **404（删除或转私有）**：作者账号 `majiabin2020` 仍存活（23 个公开仓库），但列表中已无 WorkMami，原地址不可访问。
- **主用备份（事实上存在、已验证）**：`ForgetiExistence/WorkMami`（分支 `main` @ `3e56cdb9`，3 个提交，MIT）。README 与本地逐字一致，含完整图标集与 `website/` 资源；非 GitHub fork（无 parent），为重新上传的 v0.1.0 快照。
- 其他线索：`laycen/WorkMami-rebuild`（个人重建，无说明）；`hindleycheng/more`（基于 WorkMami MIT 改造的衍生品，**不是备份**）。

### 1.2 远程配置（默认走镜像）
| 远程 | 地址 | 用途 |
| --- | --- | --- |
| `origin` | `https://gh-proxy.com/https://github.com/ForgetiExistence/WorkMami.git` | 默认 fetch，经公益镜像中转 |
| `upstream` | `https://github.com/ForgetiExistence/WorkMami.git` | 规范直连地址，网络允许时备用 |

- 2026-10-21 实测 `ls-remote` 可用：`gh-proxy.com`、`ghproxy.net` 镜像，以及备份直连；不可用：`ghfast.top`、`github.moeyy.xyz`（连接超时），`ghproxy.cc`（TLS 校验失败）、`ghps.cc`（重定向拒绝）、`gitclone.com`、`kkgithub.com`。
- 镜像切换：`git remote set-url origin <镜像前缀>/https://github.com/ForgetiExistence/WorkMami.git`，备选前缀 `https://ghproxy.net`。

### 1.3 同步与历史断层
- 本地提交与备份无共同祖先，不能 fast-forward；跟进备份用 `git fetch origin` 后 `git merge --allow-unrelated-histories`，日常比对直接 `git diff origin/main`。
- **已知缺口**：本地缺备份中的 `src-tauri/icons/*`（全平台图标）、`website/`、`app-icon.png`（当初 API 下载跳过二进制）；仅影响 macOS 打包/官网，Windows 绿色 exe 构建不受影响，需要时从 `origin/main` 取回。

## 2. 本机环境（已就绪）

| 组件 | 位置 / 版本 |
| --- | --- |
| Rust | 1.99.1，`C:\Users\Administrator\.rustup`；cargo 镜像 rsproxy.cn（`~/.cargo/config.toml`） |
| MSVC | VS Build Tools 2022，cl.exe 14.44；`vcvars64.bat` 在 `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat` |
| Node | 已安装；前端 `npm run build`（tsc + vite） |

> 换机器/新会话重建：先 `npm install`（node_modules 不入库），Rust 依赖由 Cargo.lock 锁定，cargo 首次构建自动拉取。

## 3. 构建闭环（Windows，无命令行弹窗）

`vcvars64.bat` 直接调用会弹一个命令行用法窗口；采用「注入环境变量」方式避开（`cmd /c vcvars64.bat >nul 2>&1 && set` 逐行导入当前会话）。

```powershell
# ① 前端（产物 dist/，会被编译期嵌入 exe）
cd C:\Users\Administrator\Documents\workmami
npm run build

# ② 后端。Cargo.toml 已把 custom-protocol 列入 default，裸 cargo build --release 也会内嵌前端，
#    不会再因漏传 flag 导致首开白屏/连 devUrl；下面显式 --features custom-protocol 仅作保险，可省略。
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
}
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
cd C:\Users\Administrator\Documents\workmami\src-tauri
cargo build --release --features custom-protocol
# 产物：src-tauri\target\release\workmami.exe
# 校验内嵌：二进制里应能搜到 assets/index-*.js；搜不到即未内嵌，会去连 devUrl(127.0.0.1:1420)。
```

### 部署闭环

```powershell
$src = "C:\Users\Administrator\Documents\workmami\src-tauri\target\release\workmami.exe"
Stop-Process -Name "workmami" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Copy-Item $src "C:\Program Files\WorkMami\WorkMami.exe" -Force          # 已部署位置
Copy-Item $src "<安装包副本路径>\WorkMami_0.1.0_win_x64.exe" -Force
Start-Process "C:\Program Files\WorkMami\WorkMami.exe"
```

桌面与开机启动快捷方式均指向 `C:\Program Files\WorkMami\WorkMami.exe`。

## 4. 相对上游已完成的定制改动（基线清单）

### 4.1 调度策略
- 新增 **临期优先**（`Strategy::ExpiringFirst` / `"expiring-first"`）：有到期时间的账号按 `soonest_expire_at` 升序（最早临期先消耗），无到期时间排最后、内部按余额多优先。数据复用积分拉取阶段已算好的 `Account.quota.soonest_expire_at`，无需额外请求。
- **临期优先设为默认策略**（`Strategy::default()`）；本机 `%APPDATA%\WorkMami\settings.json` 的 `proxy.strategy` 已迁移为 `expiring-first`。
- 调度下拉文案与顺序（仅前端 label，枚举值不变）：
  1. 先消耗临近到期的积分（expiring-first）
  2. 先消耗余额多的账号（smart，原「先用大号」）
  3. 先消耗余额少的账号（drain，原「集中消耗（低余额优先）」）
  4. 各账号平均消耗（round-robin，原「轮询」）

### 4.2 托盘 / 关闭隐藏 / 单实例（lib.rs）
- 主窗口 `CloseRequested` 拦截：点 X 隐藏到托盘，不退出；托盘左键显示/隐藏，右键菜单「显示主界面 / 退出」。
- single-instance 插件：二次启动直接呼出已有主窗口，不重复起进程（二次启动自行 exit 0）。
- `Cargo.toml` tauri features 增加 `tray-icon`、`image-ico`。

### 4.3 模型列表（仿 WorkBuddy）
- 后端 `ModelInfo` 增加 `credits / tags / isDefault / vendor / raw`（raw 为官方 `listAvailableModels` 完整原始对象），`models_cache` 全量带出；原始落盘 `%APPDATA%\WorkMami\models-debug.json`。
- 前端下拉：显示「模型名 + 彩色徽章（颜色取自接口 badge:名称:#颜色）+ 右侧积分倍率 x0.xx」；底层 value 仍是真实模型 id；不显示灰色小字 id。

### 4.4 自定义模型页（WorkBuddy配置指南）
- 文案更名：`接入信息 → WorkBuddy配置指南（设置→模型→添加模型）`；`自定义模型运行中 → 运行中`；`Base URL → 接口地址`；`默认模型 → 模型名称`。
- 布局对齐 WorkBuddy「编辑模型」弹窗：服务状态 → 供应商（只读，恒为「自定义」）→ 接口地址 → API Key → 模型名称 → 高级配置 → 默认思考强度。
- 高级配置为只读建议复选框（勾选状态按官方能力字段自动给出）：工具调用 `supportsToolCall`、图片输入 `supportsImages`、思考模式 `supportsReasoning`、仅思考模式 `raw.onlyReasoning`、允许关闭思考 `raw.reasoning.canDisableThinking`、自定义协议恒不勾（标准转发路径无需开启）。
- 默认思考强度只读显示「自动（使用请求层默认值）」；移除上下文/输出灰字与 OpenAI 端点说明段；删除「调度与模型」分隔符。
- 七个小节标题（服务状态/供应商/接口地址/API Key/模型名称/高级配置/默认思考强度）统一加粗、标题色。

### 4.5 对比度（全局）
- 亮色主题 token：`colorTextSecondary rgba(0,0,0,0.65)`、`colorTextTertiary 0.45`、`colorTextPlaceholder 0.45`、`colorTextDisabled 0.55`（暗色不动）。
- 全页面辅助文字 opacity 统一上调（0.4~0.65 → 0.6~0.8）；硬编码浅灰（下拉倍率、侧边栏）加深至双主题达标色。

### 4.6 成长中心独立浏览器窗口 + 登录态门禁（人工领积分）
- 背景：WorkMami 只存插件 Bearer token（JSON API 用），不持有网页 cookie 会话；成长中心 SPA（`https://www.codebuddy.cn/profile/growth-space`）靠浏览器自身登录态，token 无法注入网页。
- 2026-10-22：成长中心地址由 `workbuddy.cn/profile/growth-center` 改为 `codebuddy.cn/profile/growth-space`——扫码登录页在 codebuddy.cn，cookie 只落在 codebuddy.cn；workbuddy.cn 是独立可注册域，cookie 不互通，原地址打开必不带登录态。
- 新增 `src-tauri/src/browser/mod.rs`：按 uid 分配独立 `--user-data-dir`（`<数据目录>/browser-profiles/<uid>`），探测本机 Edge（优先，系统自带）→ Chrome，spawn 带 `--no-first-run --no-default-browser-check`；多账号目录隔离不串号。
- **门禁（is_bound）**：只读打开 profile 的 Chromium `Cookies` 库（`Default/Network/Cookies`、回落 `Default/Cookies`），查 `host_key LIKE '%workbuddy.cn%' OR '%codebuddy.cn%'` 记录数 >0 才算已记忆；库被锁读不了时回落"文件非空"，避免误拒。
- 命令（commands.rs，均已在 lib.rs 注册）：
  - `open_growth_center(uid)`：已记忆才 spawn 打开；未记忆**不启动浏览器**，返回 `{bound:false, reason}`，前端 warning 拒绝。
  - `bind_growth_center(uid)`：不校验拉起独立窗口扫码；后端保留，前端按钮已移除、暂不调用。
  - `growth_bound_all()`：返回 `{uid:bool}` 供卡片展示「成长计划已/未记忆」。
- 前端：卡片只保留**一个**入口按钮（官方成长中心 sparkle 图标，取自 www.workbuddy.cn usercenter 前端 bundle，currentColor 单色），Tooltip 名「去成长计划做任务攒积分」；未记忆置灰，点击弹固定文案"请退出此账号重新扫码登录，即可记忆成长计划的地址"，已记忆才打开；已删除独立的"登录/记忆"按钮与昵称尾号核对。`api.openGrowthCenter / growthBoundAll`。
- 注意：WorkMami 内删除账号重走 OAuth 只刷新插件 token，**不会**建立网页独立目录；网页记忆需独立窗口扫码产生 cookie。
- 浏览器选择为自动探测、暂未做设置项；要固定 Chrome 调整 `browser/mod.rs::candidates()` 顺序即可。

## 5. 本机运行/配置位置

| 内容 | 路径 |
| --- | --- |
| 用户配置 | `%APPDATA%\WorkMami\settings.json`（strategy=expiring-first、enabled 等） |
| 官方模型原始数据（刷新覆盖） | `%APPDATA%\WorkMami\models-debug.json` |
| 已部署程序 | `C:\Program Files\WorkMami\WorkMami.exe` |

## 6. 待决策项（未改动，仅记录）

- **无 Buddy 账号的重复旅行尝试**：未领取 Buddy 的账号，`travel/status` 返回 `idle + 未达上限`，自动托管每 60 分钟巡检都会尝试 `depart` 并被服务端拒绝；`depart_failed` 不计入「当日完工」，熔断不触发，当天每小时重试、次日继续。短期频率低风险可控，长期持续失败请求不建议放任。可选修法：识别「无旅行资格」（idle + records 全空 + depart 特定错误码）后按账号跳过，复用 `travel_done_date` 思路做账号级熔断。详见 `src-tauri/src/scheduler/mod.rs::travel_tick`。

- **成长中心「扫错账号」自动识别（未做，当前仅人工核对）**：外部独立 Edge/Chrome 的 cookie 由系统加密，`is_bound` 只能判断"有无 workbuddy cookie"，**读不回网页会话归属**，故在 A 窗口扫 B 的码不会被自动发现（危害是张冠李戴，非直接封号）。当前不做身份核对，未过门禁只弹固定重新登录提示。要做到自动一体化核对，两条路：① CDP——独立实例带 `--remote-debugging-port` 启动，经 DevToolsActivePort 连 websocket，读页面 localStorage/调当前用户接口回读身份与目标 uid 比对（需引入 tokio-tungstenite、先抓网页当前用户接口）；② 改 Tauri 内嵌 WebView 扫码，登录后 execute_script 回读身份比对（放弃外部独立浏览器，需真机调网页持久化）。
