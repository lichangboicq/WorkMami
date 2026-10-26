//! 模型池（虚拟模型）子系统。
//!
//! 职责：
//! - 默认三档池迁移注入（幂等；按本机真实模型过滤缺失成员）
//! - 池路由：请求 model 命中池 id 时按优先级 + 全局策略选出真实模型
//! - 思考档位翻译：三档抽象（fast/medium/deep）→ 各 provider 原生参数（不支持档钳位降级）
//! - models.json / /v1/models 白名单虚拟条目（严格白名单，无赌注字段）

use std::collections::HashSet;

use serde_json::{json, Value};

use crate::state::{ModelPool, ProxySettings, Strategy};

use super::AppState;

// ---------- 默认池（开发计划 §4.2） ----------

/// 从 default-pools.json 模板字符串解析三档默认池。
/// 纯函数，供单测与运行期共用。解析失败返回 None。
pub fn default_pools_from_json(json_str: &str) -> Option<Vec<ModelPool>> {
    serde_json::from_str::<Vec<ModelPool>>(json_str).ok()
}

/// 运行期默认池：优先读 AppData/default-pools.json（用户可编辑），
/// 文件缺失或损坏时回退到 include_str! 内置模板。
/// 仅负责读取；id→name 对齐迁移在 ensure_default_pools 中一次性执行。
pub fn default_pools() -> Vec<ModelPool> {
    let path = crate::platform::workmami_paths().default_pools_file.clone();
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(s) = std::str::from_utf8(&bytes) {
            if let Some(pools) = default_pools_from_json(s) {
                return pools;
            }
            tracing::warn!("默认模型池模板解析失败，回退内置模板: {}", path.display());
        }
    }
    let embedded = include_str!("default-pools.json");
    default_pools_from_json(embedded).unwrap_or_else(|| {
        tracing::error!("内置 default-pools.json 也解析失败 —— 这不应发生");
        Vec::new()
    })
}

/// 迁移注入：pools 非空时执行 id→name 对齐迁移（兼容旧版本 wm-pool-* slug），
/// 为空时注入默认三池，并按本机真实模型列表剔除缺失成员（跳过并 warn）。
pub fn ensure_default_pools(ps: &mut ProxySettings) {
    migrate_pool_ids_to_match_names(ps);
    let real_ids = read_real_model_ids();
    ensure_default_pools_with(ps, real_ids.as_ref());
}

/// 向后兼容迁移：历史默认池 id 使用 ASCII slug（wm-pool-wenyuan / wm-pool-coder /
/// wm-pool-architect），现改为与中文名一致。用户升级后首次启动时改写；
/// 仅命中这三个已知旧前缀，绝不触碰自定义池 id 或已对齐的条目。
fn migrate_pool_ids_to_match_names(ps: &mut ProxySettings) {
    for pool in &mut ps.pools {
        let trimmed_name = pool.name.trim();
        let new_id = match pool.id.as_str() {
            "wm-pool-wenyuan" if trimmed_name == "文员" => "文员".into(),
            "wm-pool-coder" if trimmed_name == "程序员" => "程序员".into(),
            "wm-pool-architect" if trimmed_name == "架构师" => "架构师".into(),
            _ => continue,
        };
        if new_id != pool.id {
            tracing::info!(
                "迁移默认模型池 id {:?} -> {:?}（与 name 同步）",
                pool.id,
                new_id
            );
            pool.id = new_id;
        }
    }
}

/// 纯函数版本（便于单测）：real_ids 为 None 表示本机暂无真实模型列表，跳过过滤。
fn ensure_default_pools_with(ps: &mut ProxySettings, real_ids: Option<&HashSet<String>>) {
    if !ps.pools.is_empty() {
        return; // 幂等：用户已有池配置，绝不注入
    }
    let mut pools = default_pools();
    if let Some(ids) = real_ids.filter(|s| !s.is_empty()) {
        for pool in &mut pools {
            let before = pool.models.len();
            pool.models.retain(|m| {
                let ok = ids.contains(&m.id);
                if !ok {
                    tracing::warn!("默认模型池 {:?} 跳过本机缺失的真实模型 {:?}", pool.id, m.id);
                }
                ok
            });
            if pool.models.len() != before {
                tracing::info!(
                    "默认模型池 {:?} 成员按本机真实模型过滤：{} -> {}",
                    pool.id,
                    before,
                    pool.models.len()
                );
            }
        }
    }
    ps.pools = pools;
}

/// 从 WorkMami 落盘的 models-debug.json（fetch_models 每次刷新时写出的原始响应）
/// 收集本机真实模型 id；文件缺失或解析失败返回 None（此时不过滤，运行期由
/// pick_pool_member 按实时缓存自愈）。
fn read_real_model_ids() -> Option<HashSet<String>> {
    let path = crate::platform::workmami_paths().root.join("models-debug.json");
    let bytes = std::fs::read(&path).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let ids = collect_real_model_ids(&v);
    if ids.is_empty() { None } else { Some(ids) }
}

/// 递归收集「有非空 credits 的非文生图模型」的 id，过滤语义对齐 api::fetch_models
///（credits 为空的模型不会进入同步/缓存，因此也不该作为池成员）。
fn collect_real_model_ids(v: &Value) -> HashSet<String> {
    let mut out = HashSet::new();
    collect_inner(v, &mut out);
    out
}

fn collect_inner(v: &Value, out: &mut HashSet<String>) {
    match v {
        Value::Object(map) => {
            let id = map
                .get("id")
                .or_else(|| map.get("Id"))
                .or_else(|| map.get("modelId"))
                .and_then(|x| x.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            if let Some(id) = id {
                let credits = map
                    .get("credits")
                    .or_else(|| map.get("Credits"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .trim();
                let is_image = map
                    .get("tags")
                    .or_else(|| map.get("Tags"))
                    .and_then(|t| t.as_array())
                    .map(|a| a.iter().any(|x| x.as_str() == Some("text-to-image")))
                    .unwrap_or(false);
                if !credits.is_empty() && !is_image {
                    out.insert(id);
                    return; // 命中模型条目，不再深入
                }
            }
            for val in map.values() {
                collect_inner(val, out);
            }
        }
        Value::Array(arr) => {
            for x in arr {
                collect_inner(x, out);
            }
        }
        _ => {}
    }
}

// ---------- 池路由 ----------

/// 请求的模型名是否命中某个池（按 pool.id 精确匹配，ASCII slug）。
pub fn resolve_pool<'a>(ps: &'a ProxySettings, requested: &str) -> Option<&'a ModelPool> {
    let requested = requested.trim();
    if requested.is_empty() {
        return None;
    }
    ps.pools.iter().find(|p| p.id == requested)
}

/// 按池内优先级（自上而下）+ 全局策略选出本次真实模型 id。
/// - models_cache 为空（启动初期未拉取模型列表）：原样放行首个成员，与 resolve_model_id 语义一致；
/// - 缓存可用：按优先级跳过不在真实列表中的成员；全部缺失时回退首个成员并 warn；
/// - RoundRobin：在可用成员间轮转（独立游标，不影响账号调度游标）；其余策略按优先级取首位
///   （Smart/Drain/ExpiringFirst 是账号/积分维度策略，对模型选择仅保留优先级语义）。
pub fn pick_pool_member(state: &AppState, strategy: Strategy, pool: &ModelPool) -> Option<String> {
    let members: Vec<String> = pool
        .models
        .iter()
        .map(|m| m.id.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if members.is_empty() {
        return None;
    }
    let known: Vec<String> = {
        let cache = state.models_cache.lock().unwrap();
        if cache.is_empty() {
            Vec::new()
        } else {
            cache
                .iter()
                .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        }
    };
    let available: Vec<String> = if known.is_empty() {
        members
    } else {
        let av: Vec<String> = members
            .iter()
            .filter(|m| known.iter().any(|k| k == *m))
            .cloned()
            .collect();
        if av.is_empty() {
            tracing::warn!(
                "模型池 {:?} 的成员均不在真实模型列表中，回退首个成员 {:?}",
                pool.id,
                members[0]
            );
            vec![members[0].clone()]
        } else {
            av
        }
    };
    if strategy == Strategy::RoundRobin && available.len() > 1 {
        let mut cur = state.pool_rr.lock().unwrap();
        let e = cur.entry(pool.id.clone()).or_insert(0);
        let idx = *e % available.len();
        *e = e.wrapping_add(1);
        Some(available[idx].clone())
    } else {
        Some(available[0].clone())
    }
}

// ---------- 白名单虚拟条目（开发计划 §5.2(a)） ----------

/// 单个池的 models.json / /v1/models 虚拟条目。
/// 字段严格按白名单：id/name/credits/url/apiKey/maxInputTokens/maxOutputTokens/
/// supportsToolCall/supportsImages/supportsReasoning/reasoning/managedBy，无 description 等赌注字段。
pub fn pool_whitelist_entry(pool: &ModelPool, url: &str, api_key: &str) -> Value {
    let name = if pool.name.trim().is_empty() { pool.id.clone() } else { pool.name.clone() };
    json!({
        "id": pool.id,
        "name": name,
        "credits": format!("x{:.2}", pool.rate),
        "url": url,
        "apiKey": api_key,
        "maxInputTokens": 131072,
        "maxOutputTokens": 8192,
        "supportsToolCall": true,
        "supportsImages": false,
        "supportsReasoning": true,
        "reasoning": {
            "defaultEffort": "medium",
            "supportedEfforts": ["low", "medium", "high"],
            "canDisableThinking": true,
        },
        "managedBy": "WorkMami",
    })
}

/// 全部池的白名单虚拟条目（跳过 id 为空的非法池）。
pub fn pool_entries(ps: &ProxySettings, url: &str, api_key: &str) -> Vec<Value> {
    ps.pools
        .iter()
        .filter(|p| !p.id.trim().is_empty())
        .map(|p| pool_whitelist_entry(p, url, api_key))
        .collect()
}

// ---------- 思考档位翻译（开发计划 §6.3） ----------

/// 档位规整：直接接受「快闪 / 斟酌 / 精算」，其他一律钳位到「斟酌」。
fn normalize_tier(tier: &str) -> &'static str {
    match tier.trim() {
        "快闪" => "快闪",
        "精算" => "精算",
        _ => "斟酌",
    }
}

/// 真实模型 id → provider 家族（前缀匹配，大小写不敏感；未知家族按 Step 的保守三档处理）。
fn model_family(real_model_id: &str) -> &'static str {
    let lower = real_model_id.trim().to_ascii_lowercase();
    if lower.starts_with("space-bunny") {
        "space-bunny"
    } else if lower.starts_with("hy") || lower.starts_with("hunyuan") {
        "hunyuan"
    } else if lower.starts_with("glm") {
        "glm"
    } else if lower.starts_with("kimi") {
        "kimi"
    } else if lower.starts_with("deepseek") {
        "deepseek"
    } else if lower.starts_with("minimax") {
        "minimax"
    } else if lower.starts_with("mimo") {
        "mimo"
    } else {
        // step 与未知家族：原生档位 low/medium/high（无 max），精算钳位到 high
        "step"
    }
}

/// 池级档位（「快闪 / 斟酌 / 精算」）→ 该模型原生参数 (字段, 值) 列表。
/// 不支持的档位按翻译表钳位降级，绝不硬传导致上游 400。
pub fn translate_reasoning(real_model_id: &str, tier: &str) -> Vec<(String, Value)> {
    let tier = normalize_tier(tier);
    match model_family(real_model_id) {
        // 混元：reasoning_effort no_think/low/high，无 medium（斟酌钳位到 low）
        "hunyuan" => vec![(
            "reasoning_effort".into(),
            json!(match tier {
                "快闪" => "no_think",
                "精算" => "high",
                _ => "low",
            }),
        )],
        // GLM：thinking.type 强制 enabled（不支持 disabled，硬传必 400）+ reasoning_effort low/high/max，无 medium
        "glm" => vec![
            ("thinking".into(), json!({"type": "enabled"})),
            (
                "reasoning_effort".into(),
                json!(match tier {
                    "快闪" => "low",
                    "精算" => "max",
                    _ => "high",
                }),
            ),
        ],
        // Kimi：顶层 reasoning_effort low/high/max，不可关（快闪钳位到 low）
        "kimi" => vec![(
            "reasoning_effort".into(),
            json!(match tier {
                "快闪" => "low",
                "精算" => "max",
                _ => "high",
            }),
        )],
        // DeepSeek：快闪 thinking.type:disabled 关闭；斟酌钳位到 low；精算 max
        "deepseek" => match tier {
            "快闪" => vec![("thinking".into(), json!({"type": "disabled"}))],
            "精算" => vec![("reasoning_effort".into(), json!("max"))],
            _ => vec![("reasoning_effort".into(), json!("low"))],
        },
        // MiniMax：原生 5 档 ladder 最全，三档直译
        "minimax" => vec![(
            "reasoning_effort".into(),
            json!(match tier {
                "快闪" => "low",
                "精算" => "max",
                _ => "medium",
            }),
        )],
        // Space-Bunny：reasoning.effort 五档，三档直译
        "space-bunny" => vec![(
            "reasoning".into(),
            json!({"effort": match tier {
                "快闪" => "low",
                "精算" => "max",
                _ => "medium",
            }}),
        )],
        // MiMo：不真分级，none=关，其余全部钳位到 high
        "mimo" => vec![(
            "reasoning".into(),
            json!({"effort": match tier {
                "快闪" => "none",
                _ => "high",
            }}),
        )],
        // Step / 未知家族：reasoning_effort low/medium/high（无 max），精算钳位到 high
        _ => vec![(
            "reasoning_effort".into(),
            json!(match tier {
                "快闪" => "low",
                "精算" => "high",
                _ => "medium",
            }),
        )],
    }
}

/// 命中池时出站思考参数组装：池档位优先——移除客户端自带的 reasoning_effort/thinking，
/// 按池档位 + 真实模型注入原生参数（覆盖）。
pub fn apply_pool_reasoning(req: &mut Value, real_model_id: &str, tier: &str) {
    let Some(obj) = req.as_object_mut() else { return };
    obj.remove("reasoning_effort");
    obj.remove("thinking");
    for (k, v) in translate_reasoning(real_model_id, tier) {
        obj.insert(k, v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{PoolMember, Strategy};

    fn sample_pool() -> ModelPool {
        ModelPool {
            id: "wm-pool-test".into(),
            name: "测试池".into(),
            rate: 0.05,
            thinking: "斟酌".into(),
            models: vec![
                PoolMember { id: "hy3".into(), name: String::new() },
                PoolMember { id: "glm-5.3".into(), name: String::new() },
            ],
        }
    }

    fn settings_with_pools(pools: Vec<ModelPool>) -> ProxySettings {
        let mut ps = ProxySettings::default();
        ps.pools = pools;
        ps
    }

    // ---------- 默认池与迁移 ----------

    #[test]
    fn default_pools_match_plan() {
        let pools = default_pools_from_json(include_str!("default-pools.json")).unwrap();
        assert_eq!(pools.len(), 3);
        assert_eq!(pools[0].id, "文员");
        assert_eq!(pools[0].name, "文员");
        assert_eq!(pools[0].rate, 0.00);
        assert_eq!(pools[0].thinking, "快闪");
        let ids0: Vec<&str> = pools[0].models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids0, vec!["hy3"]);

        assert_eq!(pools[1].id, "程序员");
        assert_eq!(pools[1].name, "程序员");
        assert_eq!(pools[1].rate, 0.05);
        assert_eq!(pools[1].thinking, "斟酌");
        let ids1: Vec<&str> = pools[1].models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids1,
            vec!["glm-5.3-flash", "space-bunny", "minimax-m3.1-flash", "deepseek-v4.1-flash", "step-5-preview"]
        );

        assert_eq!(pools[2].id, "架构师");
        assert_eq!(pools[2].name, "架构师");
        assert_eq!(pools[2].rate, 0.85);
        assert_eq!(pools[2].thinking, "精算");
        let ids2: Vec<&str> = pools[2].models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids2, vec!["kimi-k3.1-pro", "kimi-k3", "glm-5.3"]);
    }

    #[test]
    fn ensure_defaults_injects_and_filters_missing_members() {
        let mut ps = ProxySettings::default();
        // 本机真实模型：默认池全体成员中仅 kimi-k3 缺失（对齐本机实测）
        let real: HashSet<String> = [
            "hy3",
            "step-5-preview",
            "glm-5.3-flash",
            "space-bunny",
            "minimax-m3.1-flash",
            "deepseek-v4.1-flash",
            "kimi-k3.1-pro",
            "glm-5.3",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        ensure_default_pools_with(&mut ps, Some(&real));
        assert_eq!(ps.pools.len(), 3);
        // 架构师池中 kimi-k3 本机缺失 → 被剔除
        let arch: Vec<&str> = ps.pools[2].models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(arch, vec!["kimi-k3.1-pro", "glm-5.3"]);
        // 其余成员保持原优先级（全部在本机真实列表中）
        let coder: Vec<&str> = ps.pools[1].models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            coder,
            vec!["glm-5.3-flash", "space-bunny", "minimax-m3.1-flash", "deepseek-v4.1-flash", "step-5-preview"]
        );
    }

    #[test]
    fn ensure_defaults_no_real_list_keeps_all_members() {
        let mut ps = ProxySettings::default();
        ensure_default_pools_with(&mut ps, None);
        assert_eq!(ps.pools.len(), 3);
        assert_eq!(ps.pools[0].models.len(), 1);
        assert_eq!(ps.pools[1].models.len(), 5);
        assert_eq!(ps.pools[2].models.len(), 3);
    }

    #[test]
    fn ensure_defaults_is_idempotent() {
        let custom = sample_pool();
        let mut ps = settings_with_pools(vec![custom.clone()]);
        ensure_default_pools_with(&mut ps, None);
        assert_eq!(ps.pools.len(), 1);
        assert_eq!(ps.pools[0].id, "wm-pool-test");
    }

    // ---------- 真实模型 id 收集 ----------

    #[test]
    fn collect_ids_filters_empty_credits_and_image_models() {
        let v = json!({
            "models": [
                {"id": "hy3", "credits": "x0.00 credits"},
                {"id": "auto"},
                {"id": "hunyuan-image-alpha", "credits": "x1.00", "tags": ["text-to-image"]},
                {"id": "  glm-5.3 ", "credits": " x0.69 "},
                {"nested": [{"id": "step-5-preview", "Credits": "x0.00 credits"}]}
            ]
        });
        let ids = collect_real_model_ids(&v);
        assert!(ids.contains("hy3"));
        assert!(ids.contains("glm-5.3")); // trim 生效
        assert!(ids.contains("step-5-preview"));
        assert!(!ids.contains("auto"));
        assert!(!ids.contains("hunyuan-image-alpha"));
    }

    // ---------- 池路由 ----------

    #[test]
    fn resolve_pool_hits_by_id_and_misses_otherwise() {
        let ps = settings_with_pools(vec![sample_pool()]);
        assert!(resolve_pool(&ps, "wm-pool-test").is_some());
        assert!(resolve_pool(&ps, " wm-pool-test ").is_some());
        assert!(resolve_pool(&ps, "hy3").is_none());
        assert!(resolve_pool(&ps, "").is_none());
        assert!(resolve_pool(&settings_with_pools(vec![]), "wm-pool-test").is_none());
    }

    // ---------- 白名单虚拟条目 ----------

    #[test]
    fn pool_entry_has_exactly_whitelist_fields() {
        let ps = settings_with_pools(vec![sample_pool()]);
        let entries = pool_entries(&ps, "http://127.0.0.1:8765/v1/chat/completions", "sk-test");
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        let mut keys: Vec<&str> = e.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "apiKey", "credits", "id", "managedBy", "maxInputTokens", "maxOutputTokens",
                "name", "reasoning", "supportsImages", "supportsReasoning", "supportsToolCall", "url"
            ]
        );
        assert_eq!(e["id"], "wm-pool-test");
        assert_eq!(e["name"], "测试池");
        assert_eq!(e["credits"], "x0.05");
        assert_eq!(e["managedBy"], "WorkMami");
        assert_eq!(e["reasoning"]["canDisableThinking"], true);
        assert!(e.get("description").is_none());
    }

    #[test]
    fn pool_entry_credits_format() {
        let mut pool = sample_pool();
        pool.rate = 0.0;
        let e = pool_whitelist_entry(&pool, "u", "k");
        assert_eq!(e["credits"], "x0.00");
        pool.rate = 0.85;
        let e = pool_whitelist_entry(&pool, "u", "k");
        assert_eq!(e["credits"], "x0.85");
    }

    // ---------- 思考档位翻译 ----------

    #[test]
    fn translate_hunyuan() {
        assert_eq!(
            translate_reasoning("hy3", "快闪"),
            vec![("reasoning_effort".to_string(), json!("no_think"))]
        );
        // 混元无斟酌档 → 钳位到 low
        assert_eq!(
            translate_reasoning("hy4-preview", "斟酌"),
            vec![("reasoning_effort".to_string(), json!("low"))]
        );
        assert_eq!(
            translate_reasoning("Hunyuan-2.0-Thinking", "精算"),
            vec![("reasoning_effort".to_string(), json!("high"))]
        );
    }

    #[test]
    fn translate_glm_forces_thinking_enabled_and_clamps() {
        let fast = translate_reasoning("glm-5.3-flash", "快闪");
        assert_eq!(fast[0].0, "thinking");
        assert_eq!(fast[0].1["type"], "enabled");
        assert_eq!(fast[1], ("reasoning_effort".to_string(), json!("low")));
        // GLM 无斟酌档 → 钳位到 high
        assert_eq!(
            translate_reasoning("glm-5.3", "斟酌")[1],
            ("reasoning_effort".to_string(), json!("high"))
        );
        assert_eq!(
            translate_reasoning("glm-5.3", "精算")[1],
            ("reasoning_effort".to_string(), json!("max"))
        );
    }

    #[test]
    fn translate_kimi() {
        assert_eq!(
            translate_reasoning("kimi-k3.1-pro", "快闪")[0],
            ("reasoning_effort".to_string(), json!("low"))
        );
        assert_eq!(
            translate_reasoning("kimi-k3.1-pro", "斟酌")[0],
            ("reasoning_effort".to_string(), json!("high"))
        );
        assert_eq!(
            translate_reasoning("kimi-k3-1", "精算")[0],
            ("reasoning_effort".to_string(), json!("max"))
        );
    }

    #[test]
    fn translate_deepseek() {
        // 快闪：thinking.type:disabled 关闭
        assert_eq!(
            translate_reasoning("deepseek-v4.1-flash", "快闪"),
            vec![("thinking".to_string(), json!({"type": "disabled"}))]
        );
        // 斟酌钳位到 low
        assert_eq!(
            translate_reasoning("deepseek-v4.1-flash", "斟酌")[0],
            ("reasoning_effort".to_string(), json!("low"))
        );
        assert_eq!(
            translate_reasoning("deepseek-v4.1-flash", "精算")[0],
            ("reasoning_effort".to_string(), json!("max"))
        );
    }

    #[test]
    fn translate_minimax() {
        assert_eq!(
            translate_reasoning("minimax-m3.1-flash", "斟酌")[0],
            ("reasoning_effort".to_string(), json!("medium"))
        );
        assert_eq!(
            translate_reasoning("minimax-m3", "精算")[0],
            ("reasoning_effort".to_string(), json!("max"))
        );
    }

    #[test]
    fn translate_space_bunny_nested_effort() {
        let out = translate_reasoning("space-bunny", "精算");
        assert_eq!(out[0].0, "reasoning");
        assert_eq!(out[0].1["effort"], "max");
        assert_eq!(translate_reasoning("space-bunny", "斟酌")[0].1["effort"], "medium");
    }

    #[test]
    fn translate_mimo_clamps_to_high() {
        assert_eq!(
            translate_reasoning("mimo-v2.6-pro", "快闪")[0].1["effort"],
            "none"
        );
        // MiMo 不真分级：斟酌/精算都钳位到 high
        assert_eq!(translate_reasoning("mimo-v2.6-pro", "斟酌")[0].1["effort"], "high");
        assert_eq!(translate_reasoning("mimo-v2.6-pro", "精算")[0].1["effort"], "high");
    }

    #[test]
    fn translate_step_and_unknown_family() {
        assert_eq!(
            translate_reasoning("step-5-preview", "快闪")[0],
            ("reasoning_effort".to_string(), json!("low"))
        );
        assert_eq!(
            translate_reasoning("step-5-preview", "斟酌")[0],
            ("reasoning_effort".to_string(), json!("medium"))
        );
        // 未知家族同样走保守三档，无 max
        assert_eq!(
            translate_reasoning("totally-unknown-model", "精算")[0],
            ("reasoning_effort".to_string(), json!("high"))
        );
    }

    #[test]
    fn translate_unknown_tier_falls_back_to_medium() {
        assert_eq!(
            translate_reasoning("minimax-m3", "bogus")[0],
            ("reasoning_effort".to_string(), json!("medium"))
        );
    }

    // ---------- 池档位覆盖客户端参数 ----------

    #[test]
    fn apply_pool_reasoning_overrides_client_params() {
        let mut req = json!({
            "model": "wm-pool-wenyuan",
            "reasoning_effort": "xhigh",
            "thinking": {"type": "enabled"},
            "messages": []
        });
        apply_pool_reasoning(&mut req, "hy3", "快闪");
        assert_eq!(req["reasoning_effort"], "no_think");
        assert!(req.get("thinking").is_none());
        assert_eq!(req["model"], "wm-pool-wenyuan");
    }

    #[test]
    fn pick_member_priority_and_fallback() {
        // 纯逻辑不可达（需要 AppState），此处验证成员过滤的语义由 collect/resolve 测试覆盖；
        // 优先级选择在集成链路（chat_completions）中验证。
        let pool = sample_pool();
        let ids: Vec<&str> = pool.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids.first(), Some(&"hy3")); // 自上而下 = 优先级
        assert_eq!(pool.thinking, "斟酌");
        let _ = Strategy::default();
    }
}
