# WorkMami「模型池」功能开发计划

> 文档用途：本计划供**新的实现会话**直接照做，已包含架构约束、已验证的事实、数据模型、后端/前端改动点、思考强度原生参数规范、默认数据、UI 规范与分步任务。请勿重复调研本文件已覆盖的内容。
>
> 设计稿（唯一视觉真相源）：`https://ardot.tencent.com/file/740286444170434`
> - 亮色画板节点：`2:380`
> - 暗色画板节点：`2:637`
> - 画板宽度：1240×520（容纳下方 tooltip 示意区）

---

## 一、目标与核心原则

在 WorkMami（Tauri + React + Ant Design 桌面应用，WorkBuddy 的本地代理）中新增**虚拟模型池**能力：

- 用户（在 WorkBuddy 模型列表里）**只看到池名**（如「文员 / 程序员 / 架构师」），**不看到真实模型名**。
- 真实模型的调参与账号调度由 WorkMami 在本机完成。
- 池是「展示名 → 真实模型 id」的映射 + 优先级 + 倍率 + 思考档位；出站请求里 `model` 字段被重写为真实 id，**池名不出本机**（仅官方客户端会话记录可能带中性中文池名，无语义线索）。

**三条硬约束（来自前期源码逆向，勿违反）：**

1. `models.json` 严格按客户端白名单输出字段，不写 `description` 等"赌注字段"（官方对自定义模型无悬停介绍卡，写了也无效且可能被判非法配置）。
2. 不暴露 WorkMami 品牌（池名用中性中文）。
3. 池级思考档位为**三选一**（单选项），不是多选；用户永远只见 三档词，模型差异由 WorkMami 出站适配器翻译/钳位消化。

---

## 二、已验证的事实与代码坐标（无需重查）

### 2.1 关键文件与行号

| 文件 | 作用 | 关键位置 |
|---|---|---|
| `src-tauri/src/proxy/mod.rs` | 代理转发核心 | `list_models` @165、`get_model` @191、`chat_completions` @214、`resolve_model_id` @386、`apply_reasoning_default` @482 |
| `src-tauri/src/state.rs` | 全局设置与持久化 | `ProxySettings` 结构体 @33-59；`AppSettings` @91-99；`save_settings` @186-194；`read_settings` @173-184 |
| `src-tauri/src/commands.rs` | Tauri 命令 | `get_settings` @43、`save_settings` @48（保存即触发代理重启 + `sync_all`）、`list_models` 已注册 |
| `src-tauri/src/lib.rs` | 命令注册 | `generate_handler!` @170-203 |
| `src-tauri/src/sync_targets/workbuddy.rs` | 写 WorkBuddy `models.json` | `sync()` @29；写出字段 @57-74；原子替换 @82-118 |
| `src-tauri/src/model_display.rs` | 真实 id ↔ 展示 id 映射 | `real_to_display` @70、`pretty_model_id` @31 |
| `src/pages/Proxy.tsx` | 代理设置前端页 | **Card 2「支持的模型」章节 @386-474**（其中 `wm-model-gallery` 网格 @445，为原位替换目标）；`loadModels` @186-203 |
| `src/App.tsx` | 侧栏宽度 | Sider = 240px |
| `tauri.conf.json` | 窗口尺寸 | 默认 1240px（min 980） |
| `styles.css` | 页面内边距 | `.wm-page` padding 20px → **Card 实宽 = 1240 − 240 − 40 = 960px** |

### 2.2 安全/合规结论（已逆向确认）

- 出站 `model` 字段在 `chat_completions` 中重写为真实 id（见 `resolve_model_id`），池名不出本机。
- 官方客户端 `app.asar` 中**无自定义模型悬停介绍卡**能力（`thinkingLevelMap` / `enrichLanguageModelFromCatalog` 仅对官方模型 id 注入；`chatInput.modelSelector.*` i18n 无 description 键）。**因此池的介绍职责由 WorkMami 自己的池卡片 + 思考档位 tooltip 承担，不要试图往 models.json 写 description。**
- `models.json` 字段白名单：`id / name / url / apiKey` 必填；`credits / managedBy / maxInputTokens / maxOutputTokens / supportsToolCall / supportsImages / supportsReasoning / reasoning{supportedEfforts,canDisableThinking,defaultEffort}` 透传并已被现有渲染验证。`credits` 用于右侧倍率徽章（如 `x0.05`）。

### 2.3 当前 `ProxySettings` 结构体（改造起点，state.rs:33-59）

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProxySettings {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub api_key: String,
    pub strategy: Strategy,
    /// 默认思考强度：low/medium/high/none
    pub reasoning_effort: String,
    /// 默认模型（客户端未指定时）
    pub default_model: String,
}
```

> **重要**：新增 `pools` 后，`save_settings`（`commands.rs:48`）会自动把它随 `AppSettings` 持久化并触发代理重启 + `sync_all`，**无需新增命令即可完成 CRUD 持久化**——前端只需把 `proxy.pools` 读出来编辑、再整体 `save_settings`。

---

## 三、功能范围（MVP）

**包含：**
1. 三档默认模型池：文员（x0.00）/ 程序员（x0.05）/ 架构师（x0.85），可增删改、拖拽排序。
2. 每个池内：模型纵向全宽行（自上而下 = 调度优先级），可拖拽排序、行内铅笔更名（池名）、新增、删除（悬停垃圾桶 + 二次确认 + 可撤销）。
3. 每个池级「思考档位」三选一下拉（快闪 / 斟酌 / 精算），带 hover tooltip 解释本意。
4. 池与模型价格标签统一灰色；亮/暗双主题。
5. WorkMami 出站时按真实模型原生参数翻译思考档位并自动钳位降级。

**不包含（本次不做）：**
- 客户端（WorkBuddy）视角的预览屏 / 新页签 / 编辑抽屉（用户已否决）。
- 自定义模型悬停介绍卡（官方不支持）。
- 多模型并行/加权混合（仅按优先级单模型调度）。

---

## 四、数据模型

### 4.1 `ProxySettings` 新增 `pools` 字段（state.rs）

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelPool {
    /// 稳定 id（ASCII slug，如 "wm-pool-wenyuan"），用于 models.json 的 id 与路由
    pub id: String,
    /// 展示名（中性中文，如 "文员"），用于 models.json 的 name 与前端显示
    pub name: String,
    /// 倍率，如 0.00 / 0.05 / 0.85（字符串 "x0.05" 写入 models.json credits）
    pub rate: f64,
    /// 思考档位：fast=快闪 / medium=斟酌 / deep=精算
    pub thinking: String,
    /// 池内成员，自上而下 = 调度优先级
    pub models: Vec<PoolMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PoolMember {
    /// 真实模型 id（与 models.json 中真实条目一致，如 "hy3"）
    pub id: String,
    /// 展示名（可选，缺省用真实模型展示名）
    pub name: String,
}

// 在 ProxySettings 中追加：
pub struct ProxySettings {
    // ... 既有字段 ...
    pub pools: Vec<ModelPool>,   // 默认空；首次启动由迁移逻辑填充三档默认值
}
```

> **slug 约定**：池 `id` 用 ASCII（避免中文进 URL / 客户端路径处理问题），`name` 用中文。`resolve_model_id` 用 `id` 识别池。

### 4.2 默认数据（首次启动迁移注入）

| 池 id | name | rate | thinking | 成员（优先级降序） |
|---|---|---|---|---|
| `wm-pool-wenyuan` | 文员 | 0.00 | fast（快闪） | `hy3` → `step-5-preview` |
| `wm-pool-coder` | 程序员 | 0.05 | medium（斟酌） | `step-5-preview` → `glm-5.3-flash` → `space-bunny` → `minimax-m3.1-flash` → `deepseek-v4.1-flash` |
| `wm-pool-architect` | 架构师 | 0.85 | deep（精算） | `kimi-k3.1-pro` → `kimi-k3` → `glm-5.3` |

> 注意：`step-5-preview` 同时出现在「文员」与「程序员」两池，属预期（真实模型可被多池复用）。

---

## 五、后端改造（Rust）

### 5.1 `state.rs` — 加 `pools` 字段 + 默认迁移
- 在 `ProxySettings` 追加 `pools: Vec<ModelPool>`（见 4.1）。
- 在 `read_settings`（@173）或 `AppState::load`（@148）中：若 `pools` 为空（全新或旧配置），注入 §4.2 默认三池（成员 id 必须与本机 `models.json` 真实 id 一致；若某真实模型缺失则跳过并记 warn）。

### 5.2 `proxy/mod.rs` — 三处核心改造

**(a) `list_models`（@165）：暴露虚拟池模型**
- 在返回数组中**追加**每个池对应的虚拟条目（保留既有真实模型条目，或按产品决策二选一；建议：池与真实模型都列出，池名带「池」标识便于区分）。
- 池虚拟条目字段（严格白名单）：
  ```json
  {
    "id": "<pool.id>",          // 如 "wm-pool-wenyuan"
    "name": "<pool.name>",      // 如 "文员"
    "credits": "x0.00",         // 倍率徽章
    "url": "<proxy baseUrl>/v1/chat/completions",
    "apiKey": "<ps.api_key>",
    "maxInputTokens": 131072,
    "maxOutputTokens": 8192,
    "supportsToolCall": true,
    "supportsImages": false,
    "supportsReasoning": true,
    "reasoning": {
      "defaultEffort": "medium",
      "supportedEfforts": ["low", "medium", "high"],
      "canDisableThinking": true
    },
    "managedBy": "WorkMami"
  }
  ```
  > 池的 `supportedEfforts` 暴露三档抽象（low/medium/high），但最终以**池配置的三选一档位为准**；`canDisableThinking:true` 使 WorkBuddy 不强制思考。

**(b) `resolve_model_id`（@386）：池 → 真实模型**
- 若 `requested` 命中某个 `pool.id`：按 `pool.models` 优先级 + 全局 `strategy`（RoundRobin/Smart/ExpiringFirst）选出本次真实模型 id 返回。
- 否则维持既有逻辑（真实 id / 展示 id 还原）。
- 需记录"本次请求来自哪个池"（供 (c) 使用）——建议在 `chat_completions` 调用链中把命中池引用一并下传，或在 `resolve_model_id` 之外新增 `resolve_pool(requested) -> Option<&ModelPool>`。

**(c) 思考档位翻译（新增 `translate_reasoning`，在出站构造上游请求前调用）**
- 触发点：`chat_completions`（@214）解析完请求、调用 `resolve_model_id` 得到真实模型后。
- 行为：**池档位优先于客户端自带 effort**。若本次请求命中池，则忽略客户端 `reasoning_effort`/`thinking`，按池的 `thinking` 档位 + 真实模型 id，查 §六 的翻译表写入原生参数（覆盖）。
- 实现 `fn translate_reasoning(real_model_id: &str, tier: &str) -> Vec<(String, Value)>` 返回要注入请求体的 (字段,值) 列表（如混元 → `("reasoning_effort","no_think")`；GLM → `("thinking",{type:"enabled"})` + `("reasoning_effort","low")`；DeepSeek → `("thinking",{type:"disabled"})`……）。
- 不支持的档**钳位降级**（见 §六 表格 `⚠` 项），绝不硬传导致上游 400。

### 5.3 `sync_targets/workbuddy.rs` — 写池虚拟模型
- 在 `sync()`（@29）的 `ours` 构建逻辑中，除了既有真实模型，再为每个池追加 §5.2(a) 同款虚拟条目（字段白名单一致，`managedBy:"WorkMami"`），使 WorkBuddy 客户端能看到并选择池。
- 复用既有"按 `managedBy` 过滤旧条目再原子替换"的机制（@82-118），无需改动。

### 5.4 `commands.rs` / `lib.rs`
- 无需新增命令：`get_settings` 已返回含 `pools` 的 `AppSettings`；`save_settings` 已持久化并重启代理 + `sync_all`。
- `lib.rs` 命令注册表无需改动（除非新增独立池命令，非必需）。

---

## 六、思考强度子系统（已逐 Provider 官方文档核实）

### 6.1 三档抽象与语义

| 档位 key | 前端词 | 用户本意（tooltip 文案） | 抽象语义 |
|---|---|---|---|
| `fast` | **快闪** | 文员本意：少想，快点干 | 该模型可用的最低思考深度 |
| `medium` | **斟酌** | 程序员本意：想，但别浪费时间和积分 | 适中思考 |
| `deep` | **精算** | 架构师本意：多想，别出错 | 该模型可用的最高深度 |

> tooltip 固定文案（进 i18n）：
> 「思考档位 · 三选一 ｜ 快闪（文员本意）：少想，快点干 ｜ 斟酌（程序员本意）：想，但别浪费时间和积分 ｜ 精算（架构师本意）：多想，别出错」

### 6.2 各 Provider 原生推理参数规范（官方文档级，已核实）

| Provider / 代表模型 | 原生思考字段 | 接受值 | 能否关闭 | 原生"极致/max" | 备注 |
|---|---|---|---|---|---|
| **腾讯混元** Hy3 / Hy4 | `reasoning_effort` | `no_think` / `low` / `high` | ✅ `no_think` | ❌（上限=high） | **无 medium** |
| **智谱 GLM** GLM-5.3 / 5.3-Flash | `thinking.type`(强制 enabled) + `reasoning_effort` | `low` / `high` / `max` | ❌（disabled 直接报错） | ✅ `max` | **无 off、无 medium** |
| **月之暗面 Kimi** K3 / K3.1-Pro | 顶层 `reasoning_effort` | `low` / `high` / `max` | ❌ | ✅ `max` | 不可关 |
| **DeepSeek** V4.1-Flash / V4-Pro | `reasoning_effort`(+`thinking.type`) | `off` / `low` / `high` / `max` | ✅ `thinking.type:disabled` | ✅ `max` | medium→high、xhigh→high |
| **MiniMax** M3 / M3.1-Flash | `reasoning_effort` | `low`/`medium`/`high`/`xhigh`/`max` | ❌（关→400） | ✅ `max` | 原生 5 档 ladder 最全 |
| **Space-Bunny** | `reasoning.effort` | `low`/`medium`/`high`/`xhigh`/`max` | ❌ | ✅ `max` | 5 档 = 官方截图"低/中/高/超高/极致" |
| **小米 MiMo** V2.6-Pro | `reasoning.effort`(或 `thinking`) | `none`/…/`max` | ✅ `none` | ⚠️ 名义 max | **不真正分级**：none=关，其余全映射 high |
| **阶跃 Step** Step-5-Preview | `reasoning_effort`（推断） | `low`/`medium`/`high`（推断） | ❌ | ❌ | 公网文档被拦截，按 models.json 回退值 |

> 印证：官方客户端 7 档枚举 `off/minimal/low/medium/high/xhigh/max` = 各家原生值并集；`thinkingLevelMap` 注册表**只在 WorkBuddy 客户端生效，WorkMami 代理不碰**，因此我们"传底层原值"是天然成立的——代理只做"我们选中的档 → 真实模型原生参数"的翻译。

### 6.3 三档 → 各家原生值翻译 + 钳位表（适配器核心）

`⚠` = 该模型不原生支持此档，需钳位到右侧目标值。

| 抽象档 | 混元 Hy3 | GLM-5.3 | Kimi-K3 | DeepSeek | MiniMax-M3 / Space-Bunny | MiMo | Step-5 |
|---|---|---|---|---|---|---|---|
| **快闪**（最少思考） | `no_think` | `low` | `low` | `thinking.type:disabled` | `low` | `none` | `low` |
| **斟酌**（适中） | ⚠→`low` | ⚠→`high` | ⚠→`high` | ⚠→`low` | `medium` | ⚠→`high` | `medium` |
| **精算**（最深） | `high` | `max` | `max` | `max` | `max` | ⚠→`high` | `high` |

**结论**：三档 + 钳位后，当前三池**每一个成员都能覆盖全部三档**，无需按成员交集收敛档位——兼容性难题已被抽象层消化。

### 6.4 适配器位置（已澄清，无需再决策）
- 当前 `models.json` 全部 `url` 指向 WorkMami 自己的统一网关（`:8765` 即本代理）。请求链路：客户端 → 代理:8765 → `resolve_model_id` 还原真实 id → 代理调用真实上游。
- 因此**翻译发生在 `proxy/mod.rs` 出站构造上游请求处**（即 §5.2(c)），与"网关侧 vs 直连"无关；真实模型 id 在此时已确定，直接查表注入原生参数即可。

---

## 七、前端改造（React）

**原位替换目标**：`src/pages/Proxy.tsx` 的 Card 2「支持的模型」章节（@386-474）中、`wm-model-gallery` 网格（@445）及其上方标签（@429-437）。**保留** Card 2 的 IDE 自动配置标题区（@390-426）与刷新逻辑。

### 7.1 数据接入
- 通过既有 `get_settings` 拿到 `proxy.pools`（已含），在 `formValues` 旁维护 `pools` 本地状态。
- 所有增删改/排序/更名/档位变更 → 更新本地 `pools` → 调用既有 `save_settings`（自动持久化 + 重启代理 + 同步 WorkBuddy）。

### 7.2 布局（严格对齐设计稿，Card 实宽 960px）
- **章节标题行**：`支持的模型` 文字 + 右侧操作提示（精简一行）：「拖动排序 · 铅笔更名 · 悬停删除(可撤销) · 思考档位三选一(hover看本意) · 自动降级翻译 · 实时同步」。
- **横向看板容器**：三个等宽池卡片（约 253px）+ 最右竖列「+ 新建模型池」按钮（约 120px）。
- **池卡片结构**：
  - 头部：池名（可铅笔图标行内更名）＋ 灰色倍率标签（如 `x0.05`）＋ 右侧「思考档位」单选下拉（显示当前词 + ▾）＋ 右上角悬停显现的垃圾桶（删除整池，二次确认 + 可撤销）。
  - 主体：模型**纵向全宽行**（自上而下 = 优先级）；每行 = 拖拽柄 ｜ 模型名 ｜（右侧）该行小倍率 + 悬停显现的垃圾桶（删除单个模型，二次确认 + 可撤销）。
  - 池末：整行「+ 添加模型」（弹出模型选择器，仅列本机真实模型且未在本池者）。
- **拖拽**：用 `dnd-kit` 实现（池卡片排序 + 池内模型行排序）。

### 7.3 思考档位控件
- 每个池标题右侧下拉：**单选三选一**（快闪 / 斟酌 / 精算），非多选。
- hover 下拉框显示 §6.1 的 tooltip（深色浮层 + 三角指向）。
- 下拉框**去掉"思考强度"文字标签**，只保留「当前词 + ▾」，避免窄卡片溢出（已验证）。

### 7.4 亮/暗双主题 token（以设计稿为准）
- 暗色（设计稿 2:637）：页面 `#141216` / 大卡 `#1E1B22` / 池卡 `#26222E` / chip `#322E3A` / 边框 `#3A3440` / 正文 `#F2EEF5` / 次要 `#8B8594` / 品牌粉 `#EC4899`。
- 亮色（设计稿 2:380）：以设计稿节点色值为准（页面浅色、卡片白、池卡浅灰、边框浅灰）。
- 倍率标签与图标统一中灰（`#6B6472` 亮 / `#8B8594` 暗），避免与价格 `x` 混淆。

### 7.5 复用既有前端设施
- `api.listModels()`（Proxy.tsx @189）维持，用于「+ 添加模型」选择器加载本机真实模型。
- 沿用 `Tooltip`、`Card`、`Empty` 等 Ant Design 组件与现有 `wm-*` class 体系。

---

## 八、分步任务清单（实现会话按序执行）

1. **[后端-数据]** `state.rs`：定义 `ModelPool` / `PoolMember`；`ProxySettings` 追加 `pools`；`read_settings`/`load` 注入 §4.2 默认三池。`cargo build` 通过。
2. **[后端-路由]** `proxy/mod.rs` `resolve_model_id`：支持 `pool.id` → 真实模型（优先级 + strategy）；新增 `resolve_pool` 辅助。
3. **[后端-暴露]** `proxy/mod.rs` `list_models` 与 `sync_targets/workbuddy.rs` `sync`：按白名单追加池虚拟条目（`managedBy:"WorkMami"`）。
4. **[后端-思考]** `proxy/mod.rs` 新增 `translate_reasoning(real_model_id, tier)`，实现 §6.3 翻译 + 钳位；在 `chat_completions` 出站处调用（池档位覆盖客户端 effort）。
5. **[后端-验证]** 单元/手动验证：池名出站被重写为真实 id；三档分别注入正确原生参数；不支持档钳位不报 400。
6. **[前端-数据]** `Proxy.tsx` 接入 `proxy.pools` 本地状态 + 落盘走既有 `save_settings`。
7. **[前端-布局]** 替换 `wm-model-gallery` 为看板（三池 + 新建竖列）；池卡片头部/主体/末行结构。
8. **[前端-交互]** dnd-kit 拖拽（池排序 + 行排序）、铅笔更名、悬停垃圾桶删除（二次确认 + 可撤销）、「+ 添加模型」选择器。
9. **[前端-思考控件]** 池级三选一下拉 + hover tooltip（文案见 §6.1）。
10. **[前端-主题]** 亮/暗 token 对齐设计稿；倍率/图标中灰统一。
11. **[联调]** 启动代理 → WorkBuddy 选池 → 验证只显示池名、思考档位生效、倍率徽章正确、删除/排序实时同步。
12. **[收尾]** 更新设计稿说明 + 项目记忆；自测清单（见 §九）。

---

## 九、验收标准

- [ ] WorkBuddy 模型列表只出现「文员 / 程序员 / 架构师」等池名，不出现真实模型名（会话日志除外）。
- [ ] 出站请求 `model` 字段为真实 id；思考参数按池档位 + 真实模型原生规范注入，无 400。
- [ ] 三池默认数据、倍率、思考档位与 §4.2 一致。
- [ ] 池/模型可增删改、拖拽排序；删除有二次确认 + 可撤销；实时保存并同步 WorkBuddy。
- [ ] 思考档位三选一 + tooltip 本意文案正确；亮/暗双主题无溢出/无对比度问题。
- [ ] `models.json` 仅含白名单字段，无 `description` 等赌注字段；`managedBy:"WorkMami"` 条目可干净清理。

---

## 十、待拍板 / 风险

1. **池与真实模型是否同时在 WorkBuddy 暴露**：建议两者都列（池带「池」标识）。若产品要求只列池，需在 `list_models`/`sync` 中过滤真实条目（注意会影响「+ 添加模型」选择器来源，需另开数据源）。
2. **MiMo「精算」钳位到 high**：MiMo 不真分级，已在表中标注 `⚠→high`；若将来需真 max 需单独适配。
3. **Step-5-Preview 原生档位为推断值**：来自 `models.json` 回退，已能覆盖三档；若客户端 hover 实测与推断不符，以实测为准微调翻译表（不影响三档抽象）。
4. **`credits` 倍率字段渲染**：现有 `workbuddy.rs` 已用 `credits` 渲染右侧 `0.51x` 徽章，池倍率复用同一机制（确认 `x0.00` 渲染为 `0.00x` 或空，避免显示异常）。
5. **首次迁移幂等**：确保 `pools` 非空时不再注入默认，避免覆盖用户自定义。
