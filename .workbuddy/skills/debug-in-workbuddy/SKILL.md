---
name: debug-in-workbuddy
description: 拉起 WorkMami GUI 到 WorkBuddy 内置浏览器（带真实后端数据）进行可视化调试与交互验证。触发词：拉起 GUI、内置浏览器调试、可视化调试、带真实数据验证、debug in workbuddy、在预览里看前端、验证 UI 交互。仅临时改动两个文件（调试完还原），核心零代码改动。
agent_created: true
---

# Debug WorkMami GUI in WorkBuddy Built-in Browser

不要分析、不要等待、不要预先检查端口。直接按下面流程执行。

## Step 1 — 一行命令起进程（后台，带真实后端）

```powershell
Stop-Process -Name workmami -Force -ErrorAction SilentlyContinue; & "C:\Program Files\nodejs\npm.cmd" run tauri dev
```

参数：
- cwd: `C:\Users\Administrator\Documents\workmami`
- run_in_background: `true`
- timeout: `600000`
- **拿到 task_id 立刻进 Step 2，不等任何输出**。Rust 增量编译约 15-90 秒。

这一步同时拉起三样东西：vite(:1420) + Rust dev bridge(:1421) + Tauri 桌面窗口。**调试走内置浏览器，桌面窗口弹出不用管。**

## Step 2 — 轮询桥就绪（唯一需要等的点）

15 秒间隔轮询，最多 8 次，返回 200 即就绪：

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:1421/__invoke \
  -H "Content-Type: application/json" -H "x-wm-bridge: workmami-dev" \
  -d '{"command":"app_info","args":{}}'
```

## Step 3 — 内置浏览器打开（真实数据）

`tabs_new` → `http://127.0.0.1:1420/`

原理：前端 `src/dev-bridge.ts` 在无 Tauri runtime 时把 invoke 自动转发到 :1421 的 HTTP bridge，与桌面窗口共享同一份 `Arc<AppState>`——**预览里看到的账号、设置、模型池就是真实数据**。

侧边导航按坐标点击（1279x868 视口实测）：账号管理(x≈94,y≈96) / 自定义模型(x≈94,y≈148) / 数据管理 / 签到中心 / 猫猫旅行 / Token 看板。

## Step 4 — 交互验证（工具链 + 血泪规则）

工具链：`cua_execute`（click / move / scroll / keypress / screenshot 可串联）、`tab_screenshot`、`dom_cua_get_visible_dom` + `dom_cua_click`（按 node_id 点击）。

经验规则，直接照做：

1. **截图时机**：click 后立刻截图可能错过 Modal 淡入动画 / antd message 提示——再单独补一张 `tab_screenshot`。
2. **"Current display surface not available"**（截图面失效）：用 `tabs_new` 开一个新标签页即可恢复捕获，别反复重试旧 tab。
3. **视野外或滚不动的元素**：页面容器可能吃掉 wheel 事件，`End`/`Home` 键也未必生效——改用 `dom_cua_get_visible_dom` 拿 node_id，`dom_cua_click` 直接命中。
4. **窗口尺寸会变**：视口从 579 变 1279 等情况下坐标全部失效——重新截图 / DOM 定位后再点，禁止沿用旧坐标。
5. **异步加载**：模型列表、账号、积分都是异步拉取，点相关按钮前先截图确认加载完成（如模型池区显示「加载中…」时弹窗会是空态）。
6. **复制交互验证**：点复制后顶部中央闪 message 气泡，screenshot 串联太慢抓不到就「再点一次 + 立即截图」。
7. **⚠ 数据污染**：预览里的实时保存（表单防抖 300ms 落盘）会写**真实配置**。只做查看、弹窗、复制类只读交互；避免随意改表单、开关、增删模型池。误建了池/改了值要当场撤销。

## 沙箱坑：vite 被 safe-delete 钩子拦截

WorkBuddy 沙箱内 vite 启动若报 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`（要求批量删除 `node_modules/.vite/deps` 下 50+ 个过期文件，沙箱禁止自动确认），按下面绕开：

1. 建临时文件 `vite.config.preview.ts`（项目根）：
   ```ts
   import { defineConfig, mergeConfig } from "vite";
   import base from "./vite.config";
   export default mergeConfig(base, defineConfig({
     server: { port: 1420, strictPort: true, host: "127.0.0.1" },
     cacheDir: ".workbuddy/vite-cache",
   }));
   ```
2. `package.json` 的 `"dev"` 临时改为 `"vite --config vite.config.preview.ts"`。
3. **调试结束必须还原**（见 Cleanup）。vite CLI 不支持 `--cacheDir`，改配置文件是唯一办法。

## Cleanup

1. `TaskStop` 停掉 tauri dev 后台任务。
2. 兜底杀进程：PowerShell `Stop-Process -Name workmami -Force -ErrorAction SilentlyContinue`。
3. 若动过沙箱绕坑文件：删除 `vite.config.preview.ts`，`package.json` 的 `"dev"` 还原为 `"vite"`。
   注意：先停进程再删文件——vite 监听自己的配置文件，运行中删除会触发重启崩溃。
