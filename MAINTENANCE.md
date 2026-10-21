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

# ② 后端（必须带 --features custom-protocol，否则 release 不内嵌前端，首开白屏/连 devUrl）
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
}
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
cd C:\Users\Administrator\Documents\workmami\src-tauri
cargo build --release --features custom-protocol
# 产物：src-tauri\target\release\workmami.exe
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

### 4.4 反代页（WorkBuddy配置指南）
- 文案更名：`接入信息 → WorkBuddy配置指南（设置→模型→添加模型）`；`反代运行中 → 运行中`；`Base URL → 接口地址`；`默认模型 → 模型名称`。
- 布局对齐 WorkBuddy「编辑模型」弹窗：服务状态 → 供应商（只读，恒为「自定义」）→ 接口地址 → API Key → 模型名称 → 高级配置 → 默认思考强度。
- 高级配置为只读建议复选框（勾选状态按官方能力字段自动给出）：工具调用 `supportsToolCall`、图片输入 `supportsImages`、思考模式 `supportsReasoning`、仅思考模式 `raw.onlyReasoning`、允许关闭思考 `raw.reasoning.canDisableThinking`、自定义协议恒不勾（标准转发路径无需开启）。
- 默认思考强度只读显示「自动（使用请求层默认值）」；移除上下文/输出灰字与 OpenAI 端点说明段；删除「调度与模型」分隔符。
- 七个小节标题（服务状态/供应商/接口地址/API Key/模型名称/高级配置/默认思考强度）统一加粗、标题色。

### 4.5 对比度（全局）
- 亮色主题 token：`colorTextSecondary rgba(0,0,0,0.65)`、`colorTextTertiary 0.45`、`colorTextPlaceholder 0.45`、`colorTextDisabled 0.55`（暗色不动）。
- 全页面辅助文字 opacity 统一上调（0.4~0.65 → 0.6~0.8）；硬编码浅灰（下拉倍率、侧边栏）加深至双主题达标色。

## 5. 本机运行/配置位置

| 内容 | 路径 |
| --- | --- |
| 用户配置 | `%APPDATA%\WorkMami\settings.json`（strategy=expiring-first、enabled 等） |
| 官方模型原始数据（刷新覆盖） | `%APPDATA%\WorkMami\models-debug.json` |
| 已部署程序 | `C:\Program Files\WorkMami\WorkMami.exe` |

## 6. 待决策项（未改动，仅记录）

- **无 Buddy 账号的重复旅行尝试**：未领取 Buddy 的账号，`travel/status` 返回 `idle + 未达上限`，自动托管每 60 分钟巡检都会尝试 `depart` 并被服务端拒绝；`depart_failed` 不计入「当日完工」，熔断不触发，当天每小时重试、次日继续。短期频率低风险可控，长期持续失败请求不建议放任。可选修法：识别「无旅行资格」（idle + records 全空 + depart 特定错误码）后按账号跳过，复用 `travel_done_date` 思路做账号级熔断。详见 `src-tauri/src/scheduler/mod.rs::travel_tick`。
