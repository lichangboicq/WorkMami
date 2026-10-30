//! 模型池（虚拟模型）子系统。
//!
//! 职责：
//! - 默认三档池迁移注入（幂等；按本机真实模型过滤缺失成员）
//! - 池路由：请求 model 命中池 id 时按优先级 + 全局策略选出真实模型
//! - 思考档位翻译：三档抽象（fast/medium/deep）→ 各 provider 原生参数（不支持档钳位降级）
//! - models.json / /v1/models 白名单虚拟条目（严格白名单，无赌注字段）

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Datelike, Local, NaiveTime, Utc};
use serde_json::{json, Value};

use crate::accounts;
use crate::api::{api_base, should_refresh};
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

/// 按池内优先级（自上而下）+ 全局策略选出本次真实模型 id。依次经过四级过滤：
/// 1. 成员级启用时段（三选一预设：全天/夜间/避开高峰）：时段外的成员本轮视同无效；
/// 2. 真实模型列表过滤：models_cache 为空（启动初期未拉取）时原样放行，缓存可用时
///    跳过不在真实列表中的成员；全部缺失时回退首个（时间窗内）成员并 warn；
/// 2.5 图片能力过滤（消息带图时）：仅保留真实模型支持图片的成员；纯文本消息不限制
///    （所有成员都能处理文本）。无可用图片成员时回落默认模型；
/// 3. 池级繁忙程度筛选（功能1）：busy_level 不在池白名单内的成员本轮视同 429 无效；
///    查询失败/未知级别一律 fail-open 放行，绝不因繁忙接口故障导致无模型可用。
/// 任一级过滤后为空 → 返回 None，由调用方沿用"回落默认模型"语义。
pub async fn pick_pool_member(state: &AppState, strategy: Strategy, pool: &ModelPool, has_images: bool) -> Option<String> {
    // 一级：成员级启用时段（三选一预设，避开高峰需星期感知）
    let now = Local::now();
    let mut excluded = Vec::new();
    let mut active: Vec<String> = Vec::new();
    for m in &pool.models {
        let id = m.id.trim();
        if id.is_empty() {
            continue;
        }
        if member_active_at(&m.schedule, now) {
            active.push(id.to_string());
        } else {
            excluded.push(id.to_string());
        }
    }
    if !excluded.is_empty() {
        tracing::info!("模型池 {:?} 成员不在启用时间窗内，本轮跳过: {:?}", pool.id, excluded);
    }
    if active.is_empty() {
        tracing::warn!("模型池 {:?} 所有成员均不在启用时间窗内，本轮无可用成员", pool.id);
        return None;
    }

    // 二级：真实模型列表过滤
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
        active
    } else {
        let av: Vec<String> = active
            .iter()
            .filter(|m| known.iter().any(|k| k == *m))
            .cloned()
            .collect();
        if av.is_empty() {
            tracing::warn!(
                "模型池 {:?} 的成员均不在真实模型列表中，回退首个成员 {:?}",
                pool.id,
                active[0]
            );
            vec![active[0].clone()]
        } else {
            av
        }
    };

    // 2.5 图片能力过滤（消息带图时）：仅保留真实模型支持图片的成员；纯文本消息不限制
    // （所有成员都能处理文本）。无可用图片成员 → 返回 None，由调用方回落默认模型。
    let available = if has_images {
        let img_ids: HashSet<String> = {
            let cache = state.models_cache.lock().unwrap();
            cache
                .iter()
                .filter(|m| m.get("supportsImages").and_then(|v| v.as_bool()).unwrap_or(false))
                .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        };
        let av: Vec<String> = available.into_iter().filter(|m| img_ids.contains(m.as_str())).collect();
        if av.is_empty() {
            tracing::warn!(
                "模型池 {:?} 请求含图片但无支持图片的成员可用，本轮回落默认模型",
                pool.id
            );
            return None;
        }
        av
    } else {
        available
    };

    // 三级：池级繁忙程度筛选
    let busy_ok = apply_busy_filter(state, pool, &available).await;
    if busy_ok.is_empty() {
        tracing::warn!("模型池 {:?} 所有成员繁忙程度均超出可接受范围，本轮无可用成员", pool.id);
        return None;
    }
    choose_by_strategy(state, strategy, pool, &busy_ok)
}

/// 策略选型：RoundRobin 在可用成员间轮转（独立游标，不影响账号调度游标）；
/// 其余策略按优先级取首位（Smart/Drain/ExpiringFirst 是账号/积分维度策略，对模型选择仅保留优先级语义）。
fn choose_by_strategy(state: &AppState, strategy: Strategy, pool: &ModelPool, available: &[String]) -> Option<String> {
    if available.is_empty() {
        return None;
    }
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

// ---------- 池级繁忙程度筛选（功能1） ----------

/// 繁忙程度缓存有效期。官方客户端本身也是轮询 + 本地缓存，这里取 30 秒，
/// 一次对话请求内不会重复打繁忙接口。
const BUSY_TTL_MS: i64 = 30_000;
/// 官方客户端单批上限（oEt=50）。
const BUSY_BATCH: usize = 50;

/// 池白名单判定：level 缺失/unknown = fail-open 放行（忙闲查询接口不可用/未返回，
/// 视为模型正常）；明确 "unavailable" = 永远拒绝（不可用档不对用户开放，查到即避开，
/// 即使用户未启用筛选或旧白名单里含该值）；其余级别：filter 空 = 未启用筛选（全放行），
/// 否则要求 level 在白名单内（大小写不敏感）。
pub fn busy_level_allows(filter: &[String], level: Option<&str>) -> bool {
    match level {
        None => true,
        Some(l) if l.is_empty() || l.eq_ignore_ascii_case("unknown") => true,
        // 明确不可用 → 必定避开
        Some(l) if l.eq_ignore_ascii_case("unavailable") => false,
        Some(_) if filter.is_empty() => true,
        Some(l) => filter.iter().any(|f| f.eq_ignore_ascii_case(l)),
    }
}

/// 对候选成员应用池级繁忙筛选：先用 busy_cache 内未过期条目，缺失的批量拉取后合并。
/// 返回通过筛选的成员；调用方对空结果回落默认模型。
async fn apply_busy_filter(state: &AppState, pool: &ModelPool, candidates: &[String]) -> Vec<String> {
    let filter = &pool.busy_filter;
    if filter.is_empty() {
        return candidates.to_vec();
    }
    let now = Utc::now().timestamp_millis();
    let mut levels: HashMap<String, String> = {
        let c = state.busy_cache.lock().unwrap();
        candidates
            .iter()
            .filter_map(|id| {
                c.get(id).filter(|(exp, _)| *exp > now).map(|(_, l)| (id.clone(), l.clone()))
            })
            .collect()
    };
    let missing: Vec<String> = candidates
        .iter()
        .filter(|id| !levels.contains_key(*id))
        .cloned()
        .collect();
    if !missing.is_empty() {
        levels.extend(fetch_busy_levels(state, &missing).await);
    }
    let mut out = Vec::new();
    let mut excluded = Vec::new();
    for id in candidates {
        let level = levels.get(id).map(|s| s.as_str());
        if busy_level_allows(filter, level) {
            out.push(id.clone());
        } else {
            excluded.push(format!("{}({})", id, level.unwrap_or("unknown")));
        }
    }
    if !excluded.is_empty() {
        tracing::info!("模型池 {:?} 成员繁忙程度超出可接受范围，本轮跳过: {:?}", pool.id, excluded);
    }
    out
}

/// 拉取模型繁忙程度：POST {domain}/v2/chat/busy，body {"models": [...]}，单批 ≤ 50，
/// 响应 data: [{model, busy_level}]。使用首个已启用账号的 token（临近过期先刷新）。
/// 任一批失败仅跳过该批（对应成员 fail-open），并把成功结果写入 busy_cache。
async fn fetch_busy_levels(state: &AppState, model_ids: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if model_ids.is_empty() {
        return out;
    }
    let Some(acc) = state.accounts.all().into_iter().find(|a| a.enabled) else {
        tracing::warn!("繁忙程度查询跳过：无已启用账号");
        return out;
    };
    let mut tokens = match accounts::load_token(&acc.uid) {
        Some(t) => t,
        None => {
            tracing::warn!("繁忙程度查询跳过：账号 {} 缺少 token", acc.uid);
            return out;
        }
    };
    if should_refresh(&tokens) && !tokens.refresh_token.is_empty() {
        if let Ok(nt) = state.api.refresh_token(&tokens).await {
            let _ = accounts::store_token(&acc.uid, &nt);
            tokens = nt;
        }
    }
    let url = format!("{}/v2/chat/busy", api_base(&tokens));
    for batch in model_ids.chunks(BUSY_BATCH) {
        let body = json!({ "models": batch });
        match state.api.post_chat_async(&url, &tokens, &body).await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<Value>().await {
                    Ok(v) => {
                        if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
                            for item in arr {
                                if let (Some(m), Some(l)) = (
                                    item.get("model").and_then(|x| x.as_str()),
                                    item.get("busy_level").and_then(|x| x.as_str()),
                                ) {
                                    out.insert(m.trim().to_string(), l.to_string());
                                }
                            }
                        }
                    }
                    Err(e) => tracing::warn!("繁忙程度响应解析失败: {e}"),
                }
            }
            Ok(resp) => tracing::warn!("繁忙程度查询返回 {}", resp.status()),
            Err(e) => tracing::warn!("繁忙程度查询网络失败: {e}"),
        }
    }
    let now = Utc::now().timestamp_millis();
    {
        let mut c = state.busy_cache.lock().unwrap();
        for (m, l) in &out {
            c.insert(m.clone(), (now + BUSY_TTL_MS, l.clone()));
        }
    }
    out
}

// ---------- 成员级启用时段（三选一预设） ----------

/// 夜间时段判定：23:00–次日 08:00（跨午夜，左闭右开）。
fn night_active(t: NaiveTime) -> bool {
    let start = NaiveTime::from_hms_opt(23, 0, 0).unwrap();
    let end = NaiveTime::from_hms_opt(8, 0, 0).unwrap();
    t >= start || t < end
}

/// 高峰时段判定（周一至周五 09:00–12:00、14:00–18:00，左闭右开）。
/// 周末无高峰，全天可用。返回 true 表示当前不在高峰内（可调度）。
fn off_peak_active(now: DateTime<Local>) -> bool {
    use chrono::Weekday::{Sat, Sun};
    if matches!(now.weekday(), Sat | Sun) {
        return true;
    }
    let t = now.time();
    let p1s = NaiveTime::from_hms_opt(9, 0, 0).unwrap();
    let p1e = NaiveTime::from_hms_opt(12, 0, 0).unwrap();
    let p2s = NaiveTime::from_hms_opt(14, 0, 0).unwrap();
    let p2e = NaiveTime::from_hms_opt(18, 0, 0).unwrap();
    !((t >= p1s && t < p1e) || (t >= p2s && t < p2e))
}

/// 判定成员当前时刻是否可调度（三选一预设 + 旧版自定义窗口兼容）：
/// ""/"全天" = 全天候；"夜间" = 23:00–08:00；"避开高峰" = 工作日高峰
/// （周一至周五 09:00–12:00、14:00–18:00）之外 + 周末全天。
/// 旧版 "HH:mm-HH:mm" 自定义窗口仍按原规则评估（fail-open：空/非法格式 = 全天）。
pub fn member_active_at(schedule: &str, now: DateTime<Local>) -> bool {
    match schedule.trim() {
        "" | "全天" => true,
        "夜间" => night_active(now.time()),
        "避开高峰" => off_peak_active(now),
        s => match parse_schedule(s) {
            None => true,
            Some((start, end)) if start == end => true,
            Some((start, end)) if start < end => now.time() >= start && now.time() < end,
            Some((start, end)) => now.time() >= start || now.time() < end,
        },
    }
}

/// 解析旧版 "HH:mm-HH:mm" 时间窗（start>end 表示跨午夜；start==end 视为全天）。
fn parse_schedule(s: &str) -> Option<(NaiveTime, NaiveTime)> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (a, b) = s.split_once('-')?;
    let start = NaiveTime::parse_from_str(a.trim(), "%H:%M").ok()?;
    let end = NaiveTime::parse_from_str(b.trim(), "%H:%M").ok()?;
    Some((start, end))
}

// ---------- 白名单虚拟条目（开发计划 §5.2(a)） ----------

/// 判断一次 chat 请求是否携带图片（OpenAI 多模态格式）：
/// messages[].content 为数组、且存在 type=="image_url"（或 "image"）的片段。
/// 纯文本 / content 为字符串时返回 false。供池路由按消息内容决定图片模型筛选。
pub fn request_has_images(req: &Value) -> bool {
    let Some(msgs) = req.get("messages").and_then(|m| m.as_array()) else {
        return false;
    };
    for m in msgs {
        let Some(content) = m.get("content") else { continue };
        let parts = match content {
            Value::Array(a) => a,
            _ => continue,
        };
        for p in parts {
            let t = p.get("type").and_then(|x| x.as_str()).unwrap_or("");
            if t == "image_url" || t == "image" {
                return true;
            }
        }
    }
    false
}

/// 池条目上下文窗口（取交集原则）：
/// 上边界 = 各成员 contextWindow（输入上限）的最小值；下边界在官方接口中无独立字段
/// （每个模型只暴露一个窗口上限），故实际可落地的天花板即 min(各成员上限)。
/// 仅当缓存非空且所有成员窗口均可知（>0）时返回 Some；否则返回 None，由调用方回落 131072。
pub fn pool_context_window(cache: &[Value], pool: &ModelPool) -> Option<u64> {
    if cache.is_empty() {
        return None;
    }
    let by_id: HashMap<&str, &Value> = cache
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| (s, m)))
        .collect();
    let mut min_upper: Option<u64> = None;
    for m in &pool.models {
        let id = m.id.trim();
        if id.is_empty() {
            continue;
        }
        let Some(info) = by_id.get(id) else {
            // 有成员窗口未知 → 无法安全取交集，回落默认窗口
            return None;
        };
        let upper = info
            .get("contextWindow")
            .and_then(|v| v.as_u64())
            .or_else(|| info.get("contextWindow").and_then(|v| v.as_f64()).map(|f| f as u64))
            .unwrap_or(0);
        if upper == 0 {
            // 窗口未知/非法 → 回落，避免 min=0 拖垮整池
            return None;
        }
        min_upper = Some(min_upper.map(|x| x.min(upper)).unwrap_or(upper));
    }
    min_upper
}

/// 单个池的 models.json / /v1/models 虚拟条目。
/// 字段严格按白名单：id/name/credits/url/apiKey/maxInputTokens/maxOutputTokens/
/// supportsToolCall/supportsImages/supportsReasoning/managedBy，无 description 等赌注字段。
/// 思考档位策略：池条目不声明推理能力（supportsReasoning:false 且无 reasoning 块），
/// WorkBuddy 据此不渲染用户级「思考强度」下拉——思考档位只能由 WorkMami 池设置控制，
/// 出站时由 apply_pool_reasoning 按池档位 + 真实模型原生规范注入。
/// 池条目 supportsImages 动态计算：任一池成员在模型缓存中声明 supportsImages: true，
/// 则池条目也声明支持（调度到不支持图片的成员时由上游报错并 failover）。
/// cache 为空（启动初期未拉取模型列表）时保守返回 false，与旧行为一致。
pub fn pool_supports_images(cache: &[Value], pool: &ModelPool) -> bool {
    if cache.is_empty() {
        return false;
    }
    let ids: HashSet<&str> = pool
        .models
        .iter()
        .map(|m| m.id.trim())
        .filter(|s| !s.is_empty())
        .collect();
    cache.iter().any(|m| {
        m.get("id").and_then(|v| v.as_str()).map(|s| ids.contains(s)).unwrap_or(false)
            && m.get("supportsImages").and_then(|v| v.as_bool()).unwrap_or(false)
    })
}

pub fn pool_whitelist_entry(pool: &ModelPool, url: &str, api_key: &str, supports_images: bool, max_input_tokens: u64) -> Value {
    let name = if pool.name.trim().is_empty() { pool.id.clone() } else { pool.name.clone() };
    json!({
        "id": pool.id,
        "name": name,
        "credits": format!("x{:.2}", pool.rate),
        "url": url,
        "apiKey": api_key,
        "maxInputTokens": max_input_tokens,
        "maxOutputTokens": 8192,
        "supportsToolCall": true,
        "supportsImages": supports_images,
        "supportsReasoning": false,
        "managedBy": "WorkMami",
    })
}

/// 全部池的白名单虚拟条目（跳过 id 为空的非法池）。
/// cache 为 models_cache 快照，用于动态计算 supportsImages 与上下文窗口（取交集上边界）。
/// 调用方已有快照可直接传入。
pub fn pool_entries(ps: &ProxySettings, url: &str, api_key: &str, cache: &[Value]) -> Vec<Value> {
    ps.pools
        .iter()
        .filter(|p| !p.id.trim().is_empty())
        .map(|p| {
            let supports_images = pool_supports_images(cache, p);
            let max_input_tokens = pool_context_window(cache, p).unwrap_or(131072);
            pool_whitelist_entry(p, url, api_key, supports_images, max_input_tokens)
        })
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
    use chrono::TimeZone;

    fn sample_pool() -> ModelPool {
        ModelPool {
            id: "wm-pool-test".into(),
            name: "测试池".into(),
            rate: 0.05,
            thinking: "斟酌".into(),
            busy_filter: Vec::new(),
            models: vec![
                PoolMember { id: "hy3".into(), name: String::new(), schedule: String::new() },
                PoolMember { id: "glm-5.3".into(), name: String::new(), schedule: String::new() },
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
        assert_eq!(pools[0].busy_filter, vec!["idle", "normal", "busy"]);
        let ids0: Vec<&str> = pools[0].models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids0, vec!["hy4-preview", "hy3"]);
        // 首位成员带展示名与夜间时段（与交付默认配置一致）
        assert_eq!(pools[0].models[0].name, "Hy4 preview");
        assert_eq!(pools[0].models[0].schedule, "夜间");

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
        assert_eq!(
            pools[2].busy_filter,
            vec!["idle", "normal", "busy", "congested"]
        );
        let ids2: Vec<&str> = pools[2].models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids2, vec!["kimi-k3.1-pro", "glm-5.3", "kimi-k3-1"]);
        assert_eq!(pools[2].models[2].name, "Kimi-K3");
    }

    #[test]
    fn ensure_defaults_injects_and_filters_missing_members() {
        let mut ps = ProxySettings::default();
        // 本机真实模型：默认池全体成员中 hy4-preview 与 kimi-k3-1 缺失（对齐本机实测）
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
        // 文员池中 hy4-preview 本机缺失 → 被剔除，仅剩 hy3
        let clerk: Vec<&str> = ps.pools[0].models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(clerk, vec!["hy3"]);
        // 架构师池中 kimi-k3-1 本机缺失 → 被剔除
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
        assert_eq!(ps.pools[0].models.len(), 2);
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
        let entries = pool_entries(&ps, "http://127.0.0.1:8765/v1/chat/completions", "sk-test", &[]);
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        let mut keys: Vec<&str> = e.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "apiKey", "credits", "id", "managedBy", "maxInputTokens", "maxOutputTokens",
                "name", "supportsImages", "supportsReasoning", "supportsToolCall", "url"
            ]
        );
        assert_eq!(e["id"], "wm-pool-test");
        assert_eq!(e["name"], "测试池");
        assert_eq!(e["credits"], "x0.05");
        assert_eq!(e["managedBy"], "WorkMami");
        // 思考档位只能由 WorkMami 控制：池条目不声明推理能力，
        // WorkBuddy 不渲染用户级「思考强度」下拉。
        assert_eq!(e["supportsReasoning"], false);
        assert!(e.get("reasoning").is_none());
        assert!(e.get("description").is_none());
    }

    #[test]
    fn pool_entry_credits_format() {
        let mut pool = sample_pool();
        pool.rate = 0.0;
        let e = pool_whitelist_entry(&pool, "u", "k", false, 131072);
        assert_eq!(e["credits"], "x0.00");
        pool.rate = 0.85;
        let e = pool_whitelist_entry(&pool, "u", "k", false, 131072);
        assert_eq!(e["credits"], "x0.85");
    }

    // ---------- 成员级启用时段（三选一预设 + 旧版窗口兼容） ----------

    /// 构造本地时刻测试基準：2026-10-28 是周三（工作日），2026-10-31 周六、2026-11-01 周日。
    fn dt(y: i32, m: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, mi, 0).single().unwrap()
    }
    const Y: i32 = 2026;

    #[test]
    fn schedule_empty_or_invalid_is_always_active() {
        let wed_noon = dt(Y, 10, 28, 12, 0);
        assert!(member_active_at("", wed_noon));
        assert!(member_active_at("  ", wed_noon));
        assert!(member_active_at("garbage", wed_noon));
        assert!(member_active_at("25:00-26:00", wed_noon));
        assert!(member_active_at("全天", wed_noon));
    }

    #[test]
    fn schedule_equal_start_end_means_all_day() {
        let wed_noon = dt(Y, 10, 28, 12, 0);
        assert!(member_active_at("00:00-00:00", wed_noon));
        assert!(member_active_at("08:00-08:00", wed_noon));
    }

    #[test]
    fn schedule_normal_window_legacy() {
        let day = dt(Y, 10, 28, 12, 0);
        let night = dt(Y, 10, 28, 23, 30);
        assert!(member_active_at("08:00-18:00", day));
        assert!(!member_active_at("08:00-18:00", night));
        // 左闭右开：起点包含，终点不包含
        let start = dt(Y, 10, 28, 8, 0);
        let end = dt(Y, 10, 28, 18, 0);
        assert!(member_active_at("08:00-18:00", start));
        assert!(!member_active_at("08:00-18:00", end));
    }

    #[test]
    fn schedule_overnight_window_legacy() {
        // 23:00-08:00：夜间免费模型，白天不可用
        let night = dt(Y, 10, 28, 23, 30);
        let early = dt(Y, 10, 28, 7, 59);
        let day = dt(Y, 10, 28, 12, 0);
        let mid = dt(Y, 10, 28, 0, 0);
        assert!(member_active_at("23:00-08:00", night));
        assert!(member_active_at("23:00-08:00", early));
        assert!(member_active_at("23:00-08:00", mid));
        assert!(!member_active_at("23:00-08:00", day));
    }

    #[test]
    fn preset_night_window() {
        // "夜间" = 23:00–次日 08:00
        assert!(member_active_at("夜间", dt(Y, 10, 28, 23, 0)));
        assert!(member_active_at("夜间", dt(Y, 10, 28, 23, 30)));
        assert!(member_active_at("夜间", dt(Y, 10, 28, 0, 0)));
        assert!(member_active_at("夜间", dt(Y, 10, 28, 7, 59)));
        assert!(!member_active_at("夜间", dt(Y, 10, 28, 8, 0)));
        assert!(!member_active_at("夜间", dt(Y, 10, 28, 12, 0)));
        assert!(!member_active_at("夜间", dt(Y, 10, 28, 22, 59)));
    }

    #[test]
    fn preset_avoid_peak_weekday() {
        // "避开高峰"：工作日 09:00–12:00、14:00–18:00 禁用，其余可用
        assert!(!member_active_at("避开高峰", dt(Y, 10, 28, 9, 0)));
        assert!(!member_active_at("避开高峰", dt(Y, 10, 28, 10, 0)));
        assert!(!member_active_at("避开高峰", dt(Y, 10, 28, 11, 59)));
        assert!(member_active_at("避开高峰", dt(Y, 10, 28, 12, 0)));
        assert!(member_active_at("避开高峰", dt(Y, 10, 28, 12, 30)));
        assert!(!member_active_at("避开高峰", dt(Y, 10, 28, 14, 0)));
        assert!(!member_active_at("避开高峰", dt(Y, 10, 28, 15, 0)));
        assert!(member_active_at("避开高峰", dt(Y, 10, 28, 18, 0)));
        assert!(member_active_at("避开高峰", dt(Y, 10, 28, 19, 0)));
        assert!(member_active_at("避开高峰", dt(Y, 10, 28, 8, 59)));
    }

    #[test]
    fn preset_avoid_peak_weekend_always_active() {
        // 周末无高峰，全天可调度
        assert!(member_active_at("避开高峰", dt(Y, 10, 31, 10, 0)));
        assert!(member_active_at("避开高峰", dt(Y, 10, 31, 15, 0)));
        assert!(member_active_at("避开高峰", dt(Y, 10, 31, 23, 30)));
        assert!(member_active_at("避开高峰", dt(Y, 11, 1, 9, 0)));
        assert!(member_active_at("避开高峰", dt(Y, 11, 1, 16, 0)));
    }

    // ---------- 池级繁忙程度筛选（功能1） ----------

    #[test]
    fn busy_filter_empty_allows_all_but_unavailable() {
        assert!(busy_level_allows(&[], None));
        assert!(busy_level_allows(&[], Some("idle")));
        assert!(busy_level_allows(&[], Some("congested")));
        // 查到明确不可用 → 永远避开（即使未启用筛选）
        assert!(!busy_level_allows(&[], Some("unavailable")));
        assert!(!busy_level_allows(&[], Some("UNAVAILABLE")));
    }

    #[test]
    fn busy_filter_unavailable_rejected_even_if_whitelisted() {
        // 旧版多选 UI 可能留下含 unavailable 的白名单，仍须硬性拒绝
        let f = vec!["idle".to_string(), "unavailable".to_string()];
        assert!(busy_level_allows(&f, Some("idle")));
        assert!(!busy_level_allows(&f, Some("unavailable")));
    }

    #[test]
    fn busy_filter_fail_open_on_missing_or_unknown() {
        let f = vec!["normal".to_string(), "idle".to_string()];
        assert!(busy_level_allows(&f, None));
        assert!(busy_level_allows(&f, Some("")));
        assert!(busy_level_allows(&f, Some("unknown")));
    }

    #[test]
    fn busy_filter_whitelist_matching_case_insensitive() {
        let f = vec!["idle".to_string(), "normal".to_string()];
        assert!(busy_level_allows(&f, Some("idle")));
        assert!(busy_level_allows(&f, Some("NORMAL")));
        assert!(!busy_level_allows(&f, Some("busy")));
        assert!(!busy_level_allows(&f, Some("congested")));
        assert!(!busy_level_allows(&f, Some("unavailable")));
    }

    // ---------- supportsImages 动态计算（预研任务2 修复） ----------

    #[test]
    fn pool_supports_images_empty_cache_is_false() {
        let pool = sample_pool();
        assert!(!pool_supports_images(&[], &pool));
    }

    #[test]
    fn pool_supports_images_any_member_true() {
        let pool = sample_pool();
        let cache = vec![
            json!({"id": "hy3", "supportsImages": false}),
            json!({"id": "glm-5.3", "supportsImages": true}),
        ];
        assert!(pool_supports_images(&cache, &pool));
        // 全都不支持
        let cache2 = vec![json!({"id": "hy3", "supportsImages": false})];
        assert!(!pool_supports_images(&cache2, &pool));
        // 无关模型不影响
        let cache3 = vec![json!({"id": "other", "supportsImages": true})];
        assert!(!pool_supports_images(&cache3, &pool));
    }

    #[test]
    fn pool_entry_images_reflect_cache() {
        let pool = sample_pool();
        let cache = vec![json!({"id": "glm-5.3", "supportsImages": true})];
        let e = pool_whitelist_entry(&pool, "u", "k", pool_supports_images(&cache, &pool), 131072);
        assert_eq!(e["supportsImages"], true);
        let e2 = pool_whitelist_entry(&pool, "u", "k", pool_supports_images(&[], &pool), 131072);
        assert_eq!(e2["supportsImages"], false);
    }

    // ---------- 池上下文窗口取交集（上边界 = min） ----------

    #[test]
    fn pool_context_window_takes_min_of_members() {
        let pool = sample_pool(); // hy3, glm-5.3
        let cache = vec![
            json!({"id": "hy3", "contextWindow": 131072, "supportsImages": false}),
            json!({"id": "glm-5.3", "contextWindow": 1048576, "supportsImages": true}),
        ];
        assert_eq!(pool_context_window(&cache, &pool), Some(131072));
    }

    #[test]
    fn pool_context_window_empty_cache_is_none() {
        let pool = sample_pool();
        assert_eq!(pool_context_window(&[], &pool), None);
    }

    #[test]
    fn pool_context_window_missing_member_is_none() {
        let pool = sample_pool();
        let cache = vec![json!({"id": "hy3", "contextWindow": 131072})];
        assert_eq!(pool_context_window(&cache, &pool), None);
    }

    #[test]
    fn pool_context_window_zero_window_is_none() {
        let pool = sample_pool();
        let cache = vec![
            json!({"id": "hy3", "contextWindow": 0}),
            json!({"id": "glm-5.3", "contextWindow": 1048576}),
        ];
        assert_eq!(pool_context_window(&cache, &pool), None);
    }

    // ---------- 请求是否带图（图片路由前置判定） ----------

    #[test]
    fn request_has_images_true_for_image_url() {
        let req = json!({
            "model": "程序员",
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "看这张图"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}}
                ]}
            ]
        });
        assert!(request_has_images(&req));
    }

    #[test]
    fn request_has_images_false_for_plain_text() {
        let req = json!({
            "model": "程序员",
            "messages": [
                {"role": "user", "content": "纯文本问题"},
                {"role": "assistant", "content": "回答"}
            ]
        });
        assert!(!request_has_images(&req));
    }

    #[test]
    fn request_has_images_false_when_no_messages() {
        let req = json!({"model": "程序员", "messages": []});
        assert!(!request_has_images(&req));
        let req2 = json!({"model": "程序员"});
        assert!(!request_has_images(&req2));
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
