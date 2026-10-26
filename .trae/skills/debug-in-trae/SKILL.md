---
name: debug-in-trae
description: 拉起 WorkMami GUI 到 TRAE SOLO 预览面板（带真实后端数据）。触发词：拉起 GUI、预览、打开前端、run GUI in preview、see app in TRAE editor。零代码改动。
---

# Debug WorkMami GUI in TRAE SOLO Preview

不要分析、不要等待、不要检查端口/健康状态。直接按下面 2 步执行。

## Step 1 — 一行命令起进程（后台）

```powershell
Stop-Process -Name workmami -Force -ErrorAction SilentlyContinue; & "C:\Program Files\nodejs\npm.cmd" run tauri dev
```

参数：
- cwd: `c:\Users\Administrator\Documents\workmami`
- run_in_background: `true`
- timeout: `600000`
- **拿到 command_id，立刻进 Step 2，不等任何输出**

## Step 2 — 立刻开 SOLO 预览面板

```
OpenPreview(preview_url="http://localhost:1420/", command_id=<Step1拿到的command_id>)
```

完。Vite HMR 会热重载，前端 `dev-bridge.ts` 自动走 HTTP POST 到 :1421，Rust bridge 和 Tauri window 共享同一份 `Arc<AppState>`——预览里看到的账号/设置就是真实数据。

## Cleanup

```
StopCommand(<command_id>)
```

用户说"关掉"、"停掉"、"done"时执行。
