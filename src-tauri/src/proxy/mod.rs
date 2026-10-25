//! 本地 OpenAI 兼容自定义模型服务。
//! - 监听 127.0.0.1:<port>，校验 Bearer key
//! - /v1/chat/completions：多账号调度 + 会话粘性 + failover + 流式透传
//! - /v1/models、/v1/workmami/quota、/v1/workmami/health
//! 上游为 {domain}/v2/chat/completions（强制流式，非流式客户端自动组装）。

use std::sync::Arc;

use axum::{
    body::{Body, Bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Local, Utc};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::accounts::{self, Account};
use crate::api::{api_base, should_refresh};
use crate::state::{AppState, ModelPool, Strategy};
use crate::sync_targets;
use crate::usage::RequestLog;
use tauri_plugin_notification::NotificationExt;

pub mod pools;

pub struct ProxyHandle;

/// 启动自定义模型（若 settings.proxy.enabled）。返回是否已启动。
pub async fn maybe_start(state: Arc<AppState>) -> bool {
    let ps = state.proxy_settings();
    if !ps.enabled {
        return false;
    }
    start(state).await
}

pub async fn start(state: Arc<AppState>) -> bool {
    if *state.proxy_running.lock().unwrap() {
        return true;
    }
    let ps = state.proxy_settings();
    let bind = format!("{}:{}", ps.host, ps.port);

    // 先真正绑定端口再置 running，避免"乐观置位"导致状态与实际不符。
    // 带少量重试：重启时上一个实例的优雅关闭可能尚未释放端口。
    let mut listener = None;
    for attempt in 0..20 {
        match tokio::net::TcpListener::bind(&bind).await {
            Ok(l) => {
                listener = Some(l);
                break;
            }
            Err(e) => {
                if attempt == 19 {
                    tracing::error!("自定义模型绑定 {bind} 失败: {e}");
                    return false;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    }
    let listener = match listener {
        Some(l) => l,
        None => return false,
    };

    let notify = Arc::new(Notify::new());
    // 自定义模型启动即自动同步所有已注册 IDE 配置。阻塞 I/O → blocking 线程
    {
        let st = state.clone();
        tokio::task::spawn_blocking(move || { sync_targets::sync_all(&st); });
    }
    let my_gen = {
        let mut g = state.proxy_gen.lock().unwrap();
        *g += 1;
        *g
    };
    {
        *state.proxy_shutdown.lock().unwrap() = Some(notify.clone());
        *state.proxy_running.lock().unwrap() = true;
    }

    let app = build_router(state.clone());
    let st = state.clone();
    tokio::spawn(async move {
        let serve = axum::serve(listener, app)
            .with_graceful_shutdown(async move { notify.notified().await });
        if let Err(e) = serve.await {
            tracing::error!("自定义模型退出: {e}");
        }
        // 仅当自己仍是当前活动代次时才清除 running，避免旧实例退出把新实例状态覆盖为 false。
        if *st.proxy_gen.lock().unwrap() == my_gen {
            *st.proxy_running.lock().unwrap() = false;
            st.proxy_shutdown.lock().unwrap().take();
        }
    });
    true
}

pub fn stop(state: &Arc<AppState>) {
    // 用 notify_one（会保留一个许可）而非 notify_waiters，避免"尚无等待者"时关闭信号丢失、端口不释放。
    if let Some(n) = state.proxy_shutdown.lock().unwrap().take() {
        n.notify_one();
    }
    *state.proxy_running.lock().unwrap() = false;
}

fn build_router(state: Arc<AppState>) -> Router {
    let authed = Router::new()
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/completions", post(chat_completions))
        .route("/v1/models", get(list_models))
        .route("/v1/models/:id", get(get_model))
        .route("/v1/workmami/quota", get(quota_endpoint))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_key));

    Router::new()
        .route("/v1/workmami/health", get(health))
        .merge(authed)
        .with_state(state)
        .layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any),
        )
}

// ---------- 鉴权中间件 ----------
async fn require_key(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let ps = state.proxy_settings();
    if !ps.api_key.is_empty() {
        let provided = req
            .headers()
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim().strip_prefix("Bearer ").unwrap_or(s.trim()).to_string())
            .unwrap_or_default();
        if provided != ps.api_key {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": {"message": "无效的 API Key", "type": "auth_error"}})),
            )
                .into_response();
        }
    }
    next.run(req).await
}

// ---------- 端点 ----------
async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    let running = *state.proxy_running.lock().unwrap();
    Json(json!({
        "ok": true,
        "running": running,
        "platform": crate::platform::platform_name(),
        "accounts": state.accounts.all().len(),
    }))
}

async fn list_models(State(state): State<Arc<AppState>>) -> Json<Value> {
    let ps = state.proxy_settings();
    // 池虚拟条目（白名单字段）：模型池与真实模型一并列出，客户端可按池名选择。
    let pool_models = {
        let display_host = if ps.host == "0.0.0.0" { "127.0.0.1" } else { ps.host.as_str() };
        let url = format!("http://{display_host}:{}/v1/chat/completions", ps.port);
        pools::pool_entries(&ps, &url, &ps.api_key)
    };
    // 优先返回已从 WorkBuddy 实时拉取并缓存的内置模型列表；
    // 尚未拉取时回落到本地配置的默认模型 + 别名映射，保证端点始终可用。
    let cached: Vec<Value> = state
        .models_cache
        .lock()
        .unwrap()
        .iter()
        .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(|id| {
            json!({
                "id": id,
                "object": "model",
                "created": m.get("contextWindow").and_then(|v| v.as_i64()).unwrap_or(0),
                "owned_by": "workbuddy",
            })
        }))
        .collect();
    if !cached.is_empty() {
        let mut data = cached;
        data.extend(pool_models);
        return Json(json!({"object": "list", "data": data}));
    }
    // 尚未拉取模型列表时，至少回落到默认模型，保证端点始终可用。
    let mut data = vec![json!({"id": ps.default_model, "object": "model", "owned_by": "workbuddy"})];
    data.extend(pool_models);
    Json(json!({"object": "list", "data": data}))
}

async fn get_model(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Json<Value> {
    let _ = state.proxy_settings();
    Json(json!({"id": id, "object": "model", "owned_by": "workbuddy"}))
}

async fn quota_endpoint(State(state): State<Arc<AppState>>) -> Json<Value> {
    let list: Vec<Value> = state
        .accounts
        .all()
        .into_iter()
        .map(|a| {
            json!({
                "uid": a.uid,
                "nickname": a.nickname,
                "quota": a.quota,
                "enabled": a.enabled,
                "cooling": state.is_cooling(&a.uid),
            })
        })
        .collect();
    Json(json!({"accounts": list, "ts": Utc::now().to_rfc3339()}))
}

async fn chat_completions(State(state): State<Arc<AppState>>, headers: HeaderMap, body: Bytes) -> Response {
    let ua = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return err_resp(StatusCode::BAD_REQUEST, &format!("请求体解析失败: {e}")),
    };

    let ps = state.proxy_settings();
    // 模型解析：客户端传什么就用什么，未传则用默认模型。
    // 解析顺序：先看是否命中模型池 id（虚拟池名）→ 按池内优先级选出真实模型；
    // 否则走原有真实/展示 id 还原；请求的模型不在已知列表中（例如用户误填 API Key 作为
    // 模型名）时自动回落到默认模型。
    let requested_raw = req
        .get("model")
        .and_then(|m| m.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("")
        .to_string();
    // 池命中检查：请求名为空时默认模型也可能是池 id（用户把池设为默认模型）
    let pool: Option<&ModelPool> = pools::resolve_pool(
        &ps,
        if requested_raw.is_empty() { ps.default_model.as_str() } else { &requested_raw },
    );
    let requested = match pool {
        Some(p) => match pools::pick_pool_member(&state, ps.strategy, p) {
            Some(real) => real,
            None => {
                tracing::warn!("模型池 {:?} 无可用成员，回落默认模型 {:?}", p.id, ps.default_model);
                ps.default_model.clone()
            }
        },
        None if requested_raw.is_empty() => ps.default_model.clone(),
        None => resolve_model_id(&state, &requested_raw).unwrap_or_else(|| {
            tracing::warn!(
                "请求模型 {:?} 不在已知列表中，回落到默认模型 {:?}",
                requested_raw,
                ps.default_model
            );
            ps.default_model.clone()
        })
    };
    if let Some(obj) = req.as_object_mut() {
        obj.insert("model".into(), json!(requested));
    }
    // 思考档位：命中池时池档位优先（覆盖客户端自带 effort/thinking，按真实模型原生规范注入）；
    // 未命中池维持既有默认行为。池档位为空视为未配置，走默认行为。
    match pool {
        Some(p) if !p.thinking.trim().is_empty() => {
            pools::apply_pool_reasoning(&mut req, &requested, &p.thinking)
        }
        _ => apply_reasoning_default(&mut req, &ps),
    }

    let is_stream = req.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);

    // 候选账号池（策略排序 + 冷却/零积分过滤）
    let candidates = select_candidates(&state);
    if candidates.is_empty() {
        // 全部账号处于频控冷却：把 429 原样抛回客户端，并附预计恢复时刻
        if let Some(retry_at) = state.earliest_recovery_ms() {
            return rate_limited_resp(retry_at);
        }
        return err_resp(
            StatusCode::SERVICE_UNAVAILABLE,
            "没有可用账号：请在“账号管理”导入或授权账号，或检查积分是否耗尽",
        );
    }

    // 全池 failover：按「临期优先」顺序逐个尝试，直到成功或账号池耗尽。
    let mut last_err = String::from("无可用上游");
    let mut failures = 0usize;
    let mut rate_limited_only = true;
    let mut earliest_retry: Option<i64> = None;
    let total = candidates.len();
    for (i, acc) in candidates.iter().enumerate() {
        match forward_once(&state, acc, req.clone(), is_stream, &ua, &requested).await {
            Ok(resp) => return resp,
            Err(e) => {
                failures += 1;
                if let FwdErr::RateLimited { retry_at, raw } = &e {
                    earliest_retry = Some(earliest_retry.map_or(*retry_at, |v: i64| v.min(*retry_at)));
                    // 后面还有候选账号 → 立即发换号通知；最后一个不发（账号池空了）
                    if i < total - 1 {
                        notify_rate_limit_switch(&state, &acc.uid, &candidates[i + 1], raw);
                    }
                } else {
                    rate_limited_only = false;
                }
                last_err = e.msg();
            }
        }
    }
    // 整池都被频控：429 原样抛给客户端，由客户端按自己的节奏退避重试
    if failures > 0 && rate_limited_only {
        return rate_limited_resp(earliest_retry.unwrap_or_else(|| Utc::now().timestamp_millis() + 60_000));
    }
    err_resp(StatusCode::BAD_GATEWAY, &format!("所有账号转发失败：{last_err}"))
}

// ---------- 转发错误分类 ----------
enum FwdErr {
    /// 频控/限流：附服务器通知的预计恢复时间（unix ms）与报文原文（通知用）。
    RateLimited { retry_at: i64, raw: String },
    /// 这一组积分已耗尽（换下一组临期积分接棒）。
    QuotaOut,
    Other(String),
}

impl FwdErr {
    fn msg(&self) -> String {
        match self {
            FwdErr::RateLimited { retry_at, .. } => {
                format!("访问频率过高，预计 {} 恢复", fmt_hm(*retry_at))
            }
            FwdErr::QuotaOut => "账号积分耗尽".into(),
            FwdErr::Other(m) => m.clone(),
        }
    }
}

fn fmt_hm(ms: i64) -> String {
    use chrono::TimeZone;
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%H:%M").to_string())
        .unwrap_or_default()
}

/// 账号池全被频控时的 429 响应：语义与上游一致，并带预计恢复时刻。
fn rate_limited_resp(retry_at_ms: i64) -> Response {
    let now = Utc::now().timestamp_millis();
    let mins = (retry_at_ms - now).max(0) / 60_000 + 1;
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({"error": {
            "message": format!("访问频率过高，预计 {} 恢复（约 {} 分钟）", fmt_hm(retry_at_ms), mins),
            "type": "rate_limit_error",
        }})),
    )
        .into_response()
}

// ---------- 限流换号价值汇报（托盘通知） ----------
/// 通知文案组装（纯函数便于测试）：空报文回退官方核心词「访问频率过高」。
/// 标题：已切换账号至{新账号昵称}；正文：账号{旧账号昵称}遇到错误：{报文原文}。
fn rate_notice_copy(new_nick: &str, old_nick: &str, raw: &str) -> (String, String) {
    let raw = if raw.trim().is_empty() { "访问频率过高" } else { raw };
    (format!("已切换账号至{new_nick}"), format!("账号{old_nick}遇到错误：{raw}"))
}

/// 频控被拦、换号化解时立即弹一条系统通知（跨平台统一：Windows 托盘区 toast / macOS 右上横幅）。
/// 无全局节流：同一请求周期内每个 old_uid 只会被线性遍历一次，天然去重。
pub(crate) fn notify_rate_limit_switch(state: &Arc<AppState>, old_uid: &str, new_acc: &Account, raw: &str) {
    let Some(app) = state.app_handle.get().cloned() else { return }; // AppHandle 未注入（纯防御）
    let (title, body) = rate_notice_copy(
        &account_label(state, &new_acc.uid),
        &account_label(state, old_uid),
        raw,
    );
    // 旁路线程发送：绝不阻塞响应返回；任何失败仅 warn 静默
    std::thread::spawn(move || {
        if let Err(e) = app.notification().builder().title(&title).body(&body).show() {
            tracing::warn!("限流通知发送失败: {e}");
        }
    });
}

/// 通知里的账号称呼：昵称原样全量不截断；为空回退 uid 尾 4 位。
fn account_label(state: &Arc<AppState>, uid: &str) -> String {
    match state.accounts.get(uid) {
        Some(a) if !a.nickname.trim().is_empty() => a.nickname.clone(),
        _ => uid
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect(),
    }
}

// ---------- 模型验证 ----------
/// 把客户端传入的模型名解析为上游真实模型 id。
/// WorkBuddy 自定义模型条目用展示用 id（如 Deepseek-V4-Pro）作为模型名，
/// 这里通过同一套展示名映射还原成真实 id（deepseek-v4-pro）。
/// 缓存为空（尚未拉取过模型列表）时原样放行，避免启动初期误拦。
fn resolve_model_id(state: &Arc<AppState>, requested: &str) -> Option<String> {
    if requested.is_empty() {
        return None;
    }
    let ps = state.proxy_settings();
    if requested == ps.default_model {
        return Some(requested.to_string());
    }
    let cache = state.models_cache.lock().unwrap();
    if cache.is_empty() {
        return Some(requested.to_string());
    }
    // 1) 真实 id 精确匹配（其他 IDE 直接同步真实 id 的情况）
    if let Some(id) = cache.iter().find_map(|m| {
        let id = m.get("id")?.as_str()?;
        (id == requested).then(|| id.to_string())
    }) {
        return Some(id);
    }
    // 2) 展示用 id 匹配
    crate::model_display::real_to_display(&cache)
        .into_iter()
        .find_map(|(real, display)| (display == requested).then_some(real))
}

// ---------- 调度 ----------
/// 选出当前可用账号池：按策略排序；冷却中、零余量积分的账号直接出局。
/// 池空时由上层区分处理：全频控 → 429 原样抛回；无账号/无积分 → 503。
fn select_candidates(state: &Arc<AppState>) -> Vec<Account> {
    let ps = state.proxy_settings();
    let mut enabled: Vec<Account> = state
        .accounts
        .enabled_accounts()
        .into_iter()
        .filter(|a| accounts::load_token(&a.uid).is_some())
        // 这一组积分用完了 → 立刻出局，由下一组临期积分接棒（不等任何窗口超时）
        .filter(|a| a.quota.as_ref().map_or(true, |q| q.remaining > 0.0))
        .collect();
    if enabled.is_empty() {
        return Vec::new();
    }
    // 频控冷却中的账号不放行：全在冷却 → 空池 → 上层把 429 原样抛回客户端
    enabled.retain(|a| !state.is_cooling(&a.uid));
    if enabled.is_empty() {
        return Vec::new();
    }

    match ps.strategy {
        Strategy::RoundRobin => {
            let mut c = state.rr_cursor.lock().unwrap();
            let n = enabled.len().max(1);
            let start = *c % n;
            *c = c.wrapping_add(1);
            let mut v = enabled.clone();
            v.rotate_left(start);
            v
        }
        Strategy::Drain => {
            // 集中消耗余额最少的
            enabled.sort_by(|a, b| remaining(a).partial_cmp(&remaining(b)).unwrap_or(std::cmp::Ordering::Equal));
            enabled
        }
        Strategy::Smart => {
            // 余额多的优先
            enabled.sort_by(|a, b| remaining(b).partial_cmp(&remaining(a)).unwrap_or(std::cmp::Ordering::Equal));
            enabled
        }
        Strategy::ExpiringFirst => {
            // 临期优先：优先消耗最早到期（且仍有余量）的账号。
            // soonest_expire_at 由积分拉取逻辑保证为“余量 > 0 的资源中最早的到期时间”，
            // 因此天然排除已过期 / 零余量资源。排序规则：
            // - 有到期时间的账号，到期越早越靠前；
            // - 无到期时间的账号排最后，内部按余额多优先（避免长期账户被饿死）。
            enabled.sort_by(|a, b| match (soonest_expire(a), soonest_expire(b)) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => remaining(b)
                    .partial_cmp(&remaining(a))
                    .unwrap_or(std::cmp::Ordering::Equal),
            });
            enabled
        }
    }
}

fn remaining(a: &Account) -> f64 {
    a.quota.as_ref().map(|q| q.remaining).unwrap_or(f64::MAX)
}

/// 账号级“最近到期时间”（毫秒）：余量 > 0 的资源中最早到期的那个。
/// None 表示无近期到期（长期有效 / 未知）。
fn soonest_expire(a: &Account) -> Option<i64> {
    a.quota.as_ref().and_then(|q| q.soonest_expire_at)
}

fn apply_reasoning_default(req: &mut Value, ps: &crate::state::ProxySettings) {
    if req.get("reasoning_effort").is_some() || req.get("thinking").is_some() {
        return; // 客户端已指定
    }
    if !ps.reasoning_effort.is_empty() && ps.reasoning_effort != "none" {
        if let Some(obj) = req.as_object_mut() {
            obj.insert("reasoning_effort".into(), json!(ps.reasoning_effort));
        }
    }
}

// ---------- SSE 错误事件截获（无感换号的基础） ----------
/// 顶层 error 事件的错误消息：HTTP 200 下的限流/频率类错误以 SSE error 事件下发。
fn error_msg(v: &Value) -> Option<String> {
    let err = v.get("error")?;
    if err.is_null() {
        return None;
    }
    Some(
        err.get("message")
            .and_then(|m| m.as_str())
            .or_else(|| err.as_str())
            .unwrap_or("上游返回错误事件")
            .to_string(),
    )
}

/// 单行 data: 载荷命中 error 事件时返回消息。
fn sse_line_error(line: &str) -> Option<String> {
    let payload = line.strip_prefix("data:")?.trim();
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }
    error_msg(&serde_json::from_str::<Value>(payload).ok()?)
}

/// 整体解析缓冲字节后命中 error 事件（跨 chunk 拆行安全）。
fn sse_error_in(chunks: &[Bytes]) -> Option<String> {
    let text: String = chunks.iter().map(|c| String::from_utf8_lossy(c)).collect();
    text.lines().find_map(sse_line_error)
}

/// 缓冲中是否已出现首个 choices 载荷（预读的放行信号）。
fn sse_has_choices(chunks: &[Bytes]) -> bool {
    let text: String = chunks.iter().map(|c| String::from_utf8_lossy(c)).collect();
    text.lines().any(|line| {
        let Some(p) = line.strip_prefix("data:") else { return false };
        let p = p.trim();
        if p.is_empty() || p == "[DONE]" {
            return false;
        }
        serde_json::from_str::<Value>(p)
            .map(|v| v.get("choices").is_some_and(|c| !c.is_null()))
            .unwrap_or(false)
    })
}

// ---------- 转发 ----------
async fn forward_once(
    state: &Arc<AppState>,
    acc: &Account,
    req: Value,
    is_stream: bool,
    ua: &str,
    model: &str,
) -> Result<Response, FwdErr> {
    let mut tokens =
        accounts::load_token(&acc.uid).ok_or_else(|| FwdErr::Other("缺少 token".into()))?;

    // 过期则刷新
    if should_refresh(&tokens) && !tokens.refresh_token.is_empty() {
        match state.api.refresh_token(&tokens).await {
            Ok(nt) => {
                let _ = accounts::store_token(&acc.uid, &nt);
                tokens = nt;
            }
            Err(e) => tracing::warn!("刷新 token 失败({}): {e}", acc.uid),
        }
    }

    // 正确上游路径：{domain}/v2/chat/completions（不支持非流式，必须强制 stream）
    let url = format!("{}/v2/chat/completions", api_base(&tokens));
    let mut upstream_req = req.clone();
    if let Some(obj) = upstream_req.as_object_mut() {
        obj.insert("stream".into(), json!(true));
        // 确保上游在流式结束时返回 usage（含真实 credit 积分）
        let so = obj.entry("stream_options").or_insert_with(|| json!({}));
        if let Some(so_obj) = so.as_object_mut() {
            so_obj.insert("include_usage".into(), json!(true));
        }
    }

    let http = &state.api;
    let started = Utc::now().timestamp_millis();
    let resp = http
        .post_chat_async(&url, &tokens, &upstream_req)
        .await
        .map_err(|e| FwdErr::Other(format!("网络错误: {e}")))?;

    let status = resp.status();
    let code = status.as_u16();
    let headers = resp.headers().clone();

    // 401：刷新一次重试；429/积分耗尽：冷却并换号
    if code == 401 {
        state.cool_down(&acc.uid, 15_000);
        return Err(FwdErr::Other(format!("账号 {} 鉴权失效(401)", acc.uid)));
    }
    if code == 429 {
        // 记录服务器通知的预计恢复时间，该账号冷却至该时刻；本请求立即换下一个账号
        let text = resp.text().await.unwrap_or_default();
        dump_chat_debug(&upstream_req, 429, &text);
        let retry_at = parse_retry_at(&headers, &text, started);
        state.cool_down_until(&acc.uid, retry_at);
        return Err(FwdErr::RateLimited { retry_at, raw: raw_error_text(&text) });
    }
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        dump_chat_debug(&upstream_req, code, &txt);
        // 这一组积分用完了：立刻换下一组临期积分，同时异步刷新本地积分把该账号摘出可用池
        if is_quota_exhausted(&txt) {
            state.cool_down(&acc.uid, 60_000);
            spawn_quota_refresh(state.clone(), acc.uid.clone());
            return Err(FwdErr::QuotaOut);
        }
        let head: String = txt.chars().take(200).collect();
        return Err(FwdErr::Other(format!("上游 {code}: {head}")));
    }

    state.clear_cooling(&acc.uid);
    let _ = state.accounts.touch_used(&acc.uid);

    if is_stream {
        // 预读到首个内容决策点：限流类错误（HTTP 200 + SSE error 事件）几乎总在首个内容
        // 之前到达，此时返回 Err 直接换号重试，客户端收不到任何错误字节（会话完全无感）。
        let mut bytes_stream = resp.bytes_stream();
        let mut pending: Vec<Bytes> = Vec::new();
        loop {
            let Some(chunk) = bytes_stream.next().await else { break };
            let chunk = chunk.map_err(|e| FwdErr::Other(format!("流读取错误: {e}")))?;
            pending.push(chunk);
            if let Some(msg) = sse_error_in(&pending) {
                dump_chat_debug(&upstream_req, 200, &format!("SSE error event: {msg}"));
                return Err(classify_sse_error(state, &acc.uid, &msg, started));
            }
            if sse_has_choices(&pending) {
                break;
            }
        }
        return stream_response(
            state,
            acc,
            model,
            started,
            bytes_stream,
            pending,
            upstream_req.clone(),
        )
        .await;
    }
    // 上游强制流式，这里收集 SSE 并组装为完整 JSON 返回给非流式客户端
    sse_to_json_response(state, acc, model, started, resp, ua, upstream_req.clone()).await
}

// ---------- 频控恢复时间解析 ----------
/// 从 429 响应解析预计恢复时间：优先 Retry-After（秒或 HTTP-date），再尝试正文，
/// 正文无明确时间则回落 60 秒。
fn parse_retry_at(headers: &HeaderMap, body: &str, now_ms: i64) -> i64 {
    if let Some(v) = headers.get("retry-after").and_then(|v| v.to_str().ok()) {
        let v = v.trim();
        if let Ok(secs) = v.parse::<i64>() {
            return now_ms + secs.max(0) * 1000;
        }
        if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(v) {
            return dt.timestamp_millis();
        }
    }
    parse_retry_text(body, now_ms).unwrap_or(now_ms + 60_000)
}

/// 从错误文本中尽力提取恢复时刻：「HH:MM」→ 下一个该时点；「N分钟后」→ 相对时刻。
fn parse_retry_text(text: &str, now_ms: i64) -> Option<i64> {
    // 「N 分钟后」/「N分钟」
    for (i, _) in text.match_indices('分') {
        let start = text[..i].char_indices().rev().find(|(_, c)| !c.is_ascii_digit());
        let ds = match start {
            None => 0,
            Some((b, c)) => b + c.len_utf8(),
        };
        let digits = text[ds..i].trim();
        if let Ok(mins) = digits.parse::<i64>() {
            if mins > 0 && mins < 24 * 60 {
                return Some(now_ms + mins * 60_000);
            }
        }
    }
    // 「HH:MM」（跳过日期前缀，如 2026-10-23 20:30 也能命中尾部时间）
    let cs: Vec<(usize, char)> = text.char_indices().collect();
    for w in cs.windows(3) {
        let (i0, c0) = w[0];
        let (i1, c1) = w[1];
        let (i2, c2) = w[2];
        if c1 != ':' || !c0.is_ascii_digit() || !c2.is_ascii_digit() {
            continue;
        }
        // 取冒号前连续数字（支持两位/一位小时）
        let mut hs = i0;
        while hs > 0 {
            let prev = text[..hs].chars().last().unwrap();
            if prev.is_ascii_digit() {
                hs -= prev.len_utf8();
            } else {
                break;
            }
        }
        let hour: i64 = text[hs..i0 + c0.len_utf8()].parse().ok()?;
        // 取冒号后两位数字
        let mut end = i2 + c2.len_utf8();
        if end < text.len() {
            let next = text[end..].chars().next().unwrap();
            if next.is_ascii_digit() {
                end += next.len_utf8();
            }
        }
        let min: i64 = text[i1 + c1.len_utf8()..end].parse().ok()?;
        if hour < 24 && min < 60 {
            use chrono::{TimeZone, Timelike};
            let now = Local
                .timestamp_millis_opt(now_ms)
                .single()?;
            let mut cand = now
                .with_hour(hour as u32)
                .and_then(|d| d.with_minute(min as u32))
                .and_then(|d| d.with_second(0))
                .and_then(|d| d.with_nanosecond(0))?;
            if cand.timestamp_millis() <= now_ms {
                cand = cand + chrono::Duration::days(1);
            }
            return Some(cand.timestamp_millis());
        }
    }
    None
}

/// 429 报文原文提取：JSON 且含 error.message → 取 message；否则整段原文（一字不改、不截断）。
fn raw_error_text(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| body.to_string())
}

/// SSE error 事件分类：积分耗尽 → 摘池+刷新；频控类 → 冷却至预计恢复时间；其余按普通错误换号。
fn classify_sse_error(state: &Arc<AppState>, uid: &str, msg: &str, now_ms: i64) -> FwdErr {
    if is_quota_exhausted(msg) {
        state.cool_down(uid, 60_000);
        spawn_quota_refresh(state.clone(), uid.to_string());
        return FwdErr::QuotaOut;
    }
    let lower = msg.to_lowercase();
    let rate = msg.contains("频率")
        || msg.contains("限流")
        || msg.contains("稍后重试")
        || lower.contains("rate limit")
        || lower.contains("too many")
        || lower.contains("429");
    if rate {
        let retry_at = parse_retry_text(msg, now_ms).unwrap_or(now_ms + 60_000);
        state.cool_down_until(uid, retry_at);
        return FwdErr::RateLimited { retry_at, raw: msg.to_string() };
    }
    FwdErr::Other(format!("上游限流/错误(自动换号): {msg}"))
}

/// 上游报积分耗尽后，异步刷新该账号积分：remaining=0 后它会立刻从可用池出局，
/// 调度自然切到下一组有效期最短的积分。
fn spawn_quota_refresh(state: Arc<AppState>, uid: String) {
    tokio::spawn(async move {
        let _ = crate::scheduler::refresh_quota(state, Some(vec![uid])).await;
    });
}

/// 上游错误文本是否为「积分耗尽」（关键词命中）。
fn is_quota_exhausted(txt: &str) -> bool {
    let lower = txt.to_lowercase();
    [
        "积分不足",
        "积分已用完",
        "积分用完",
        "余额不足",
        "额度不足",
        "配额不足",
        "insufficient",
        "exhausted",
        "quota exceeded",
        "out of credit",
        "out of quota",
    ]
    .iter()
    .any(|k| lower.contains(k))
}

/// 上游强制流式，收集 SSE chunks 后组装为 OpenAI 非流式 JSON 响应。
async fn sse_to_json_response(
    state: &Arc<AppState>,
    acc: &Account,
    model: &str,
    started: i64,
    resp: reqwest::Response,
    ua: &str,
    req: Value,
) -> Result<Response, FwdErr> {
    let mut bytes_stream = resp.bytes_stream();
    let mut content_buf = String::new();
    let mut reasoning_buf = String::new();
    let mut usage = json!({});
    let mut completion_id = String::new();
    let mut created: i64 = 0;
    let mut finish_reason = String::new();

    while let Some(chunk) = bytes_stream.next().await {
        let chunk = chunk.map_err(|e| FwdErr::Other(format!("流读取错误: {e}")))?;
        if let Ok(text) = std::str::from_utf8(&chunk) {
            for line in text.lines() {
                let payload = match line.strip_prefix("data:") {
                    Some(p) => p.trim(),
                    None => continue,
                };
                if payload == "[DONE]" || payload.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(payload) {
                    // HTTP 200 下的顶层 error 事件（如“访问频率过高”）：非流式组装期客户端
                    // 尚未收到任何字节，返回 Err 让上层换号重试，错误不透传给客户端。
                    if let Some(msg) = error_msg(&v) {
                        dump_chat_debug(&req, 200, &format!("SSE error event: {msg}"));
                        return Err(classify_sse_error(state, &acc.uid, &msg, started));
                    }
                    if completion_id.is_empty() {
                        completion_id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        created = v.get("created").and_then(|x| x.as_i64()).unwrap_or(0);
                    }
                    if let Some(u) = v.get("usage") {
                        if !u.is_null() && u.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
                            usage = u.clone();
                        }
                    }
                    if let Some(choices) = v.get("choices").and_then(|c| c.as_array()) {
                        if let Some(ch) = choices.first() {
                            if let Some(delta) = ch.get("delta") {
                                if let Some(c) = delta.get("content").and_then(|x| x.as_str()) {
                                    content_buf.push_str(c);
                                }
                                if let Some(rc) = delta.get("reasoning_content").and_then(|x| x.as_str()) {
                                    reasoning_buf.push_str(rc);
                                }
                            }
                            if let Some(fr) = ch.get("finish_reason").and_then(|x| x.as_str()) {
                                if !fr.is_empty() {
                                    finish_reason = fr.to_string();
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let latency = Utc::now().timestamp_millis() - started;
    // 诊断：非流式组装后，若命中拒绝/空内容/错误关键字，落盘供真机定位。
    if finish_reason.contains("refusal")
        || finish_reason == "content_filter"
        || content_buf.is_empty()
    {
        dump_chat_debug(&req, 200, &format!("finish_reason={finish_reason}\ncontent={content_buf}"));
    }
    log_usage(state, acc, model, &usage, latency, 0, 200, true, ua);

    let mut message = json!({"role": "assistant", "content": content_buf});
    if !reasoning_buf.is_empty() {
        message.as_object_mut().unwrap().insert("reasoning_content".into(), json!(reasoning_buf));
    }

    let out = json!({
        "id": if completion_id.is_empty() { format!("cmpl-{}", Utc::now().timestamp_millis()) } else { completion_id },
        "object": "chat.completion",
        "created": if created > 0 { created } else { Utc::now().timestamp() },
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": if finish_reason.is_empty() { "stop".to_string() } else { finish_reason }}],
        "usage": usage,
    });
    Ok(Json(out).into_response())
}

async fn stream_response(
    state: &Arc<AppState>,
    acc: &Account,
    model: &str,
    started: i64,
    bytes_stream: impl futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Unpin + Send + 'static,
    pending: Vec<Bytes>,
    req: Value,
) -> Result<Response, FwdErr> {
    use tokio::sync::mpsc;
    use tokio_stream::wrappers::ReceiverStream;

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(64);
    let state2 = state.clone();
    let acc_uid = acc.uid.clone();
    let model2 = model.to_string();

    // 后台任务：预读缓冲 + 行级透传 + 收集 usage。
    // 行级解析的意义：错误事件可能出现在任意位置（甚至与内容同 chunk），
    // 只有按行截获才能在“已发内容后”吞掉错误、注入干净收尾，客户端会话不中断。
    tokio::spawn(async move {
        let pending_stream =
            futures_util::stream::iter(pending.into_iter().map(Ok::<Bytes, reqwest::Error>));
        let mut source = pending_stream.chain(bytes_stream);
        let mut usage = json!({});
        let mut ttft: i64 = 0;
        let mut first = true;
        // 区分“上游/超时导致的中断”与“客户端主动断开”：前者应记为失败，不能谎报成成功。
        let mut upstream_err = false;
        // 诊断用：累积原始 SSE 文本（上限 200KB），命中拒绝/错误关键字时落盘。
        let mut raw: Vec<u8> = Vec::new();
        let cap = 200_000usize;
        // 跨 chunk 行缓冲：按完整行解析，拆行的事件等下一段拼齐再判。
        let mut linebuf: Vec<u8> = Vec::new();
        let mut completion_id = String::new();
        // 已触发优雅收尾：吞掉错误字节并注入 finish+[DONE]，客户端看到的是正常结束的流。
        let mut graceful_stop = false;

        while let Some(chunk) = source.next().await {
            match chunk {
                Ok(c) => {
                    if first && !c.is_empty() {
                        ttft = Utc::now().timestamp_millis() - started;
                        first = false;
                    }
                    scan_usage(&c, &mut usage);
                    if raw.len() < cap {
                        let take = (cap - raw.len()).min(c.len());
                        raw.extend_from_slice(&c[..take]);
                    }
                    if graceful_stop {
                        continue;
                    }

                    linebuf.extend_from_slice(&c);
                    let mut out: Vec<u8> = Vec::new();
                    while let Some(pos) = linebuf.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = linebuf.drain(..=pos).collect();
                        let text = String::from_utf8_lossy(&line);
                        if completion_id.is_empty() {
                            if let Some(id) = text
                                .strip_prefix("data:")
                                .and_then(|p| serde_json::from_str::<Value>(p.trim()).ok())
                                .and_then(|v| {
                                    v.get("id").and_then(|i| i.as_str()).map(String::from)
                                })
                            {
                                completion_id = id;
                            }
                        }
                        if let Some(msg) = sse_line_error(&text) {
                            // 错误事件透传会让客户端会话直接断掉 → 吞掉并优雅收尾
                            tracing::warn!("上游 SSE 错误事件，已吞掉并优雅收尾: {msg}");
                            upstream_err = true;
                            graceful_stop = true;
                            linebuf.clear();
                            break;
                        }
                        out.extend_from_slice(&line);
                    }
                    if !out.is_empty() && tx.send(Ok(out.into())).await.is_err() {
                        break; // 客户端已断开（正常，不算失败）
                    }
                }
                Err(e) => {
                    // 上游中断：不再把错误砸给客户端（会话会直接断掉），改为优雅收尾。
                    tracing::warn!("上游流中断，已优雅收尾: {e}");
                    upstream_err = true;
                    graceful_stop = true;
                    break;
                }
            }
        }

        // 正常结束：把未换行的尾部透传，避免丢字节（已优雅收尾则丢弃残余）。
        if !graceful_stop && !linebuf.is_empty() {
            let tail: Vec<u8> = std::mem::take(&mut linebuf);
            let _ = tx.send(Ok(tail.into())).await;
        }
        if graceful_stop {
            let id = if completion_id.is_empty() {
                format!("cmpl-{}", Utc::now().timestamp_millis())
            } else {
                completion_id.clone()
            };
            let tail = format!(
                "data: {{\"id\":\"{id}\",\"object\":\"chat.completion.chunk\",\"created\":{},\"model\":\"{model2}\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n",
                Utc::now().timestamp()
            );
            let _ = tx.send(Ok(tail.into())).await;
        }

        let latency = Utc::now().timestamp_millis() - started;
        let (status, ok): (i64, bool) = if upstream_err { (500, false) } else { (200, true) };
        // 命中安全拦截/错误关键字时落盘（REFUSAL 等），便于真机定位自定义模型与内置的差异。
        let text = String::from_utf8_lossy(&raw).to_string();
        if upstream_err
            || text.contains("REFUSAL")
            || text.contains("refusal")
            || text.contains("content_filter")
            || text.contains("\"error\"")
        {
            dump_chat_debug(&req, status as u16, &text);
        }
        log_usage_by_uid(&state2, &acc_uid, &model2, &usage, latency, ttft, status, ok, "");
    });

    let body = Body::from_stream(ReceiverStream::new(rx));
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(axum::http::header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Ok((headers, body).into_response())
}

fn scan_usage(chunk: &Bytes, usage: &mut Value) {
    // SSE 行：data: {json}
    if let Ok(text) = std::str::from_utf8(chunk) {
        for line in text.lines() {
            let payload = match line.strip_prefix("data:") {
                Some(p) => p.trim(),
                None => continue,
            };
            if payload == "[DONE]" || payload.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(payload) {
                if let Some(u) = v.get("usage") {
                    if !u.is_null() && u.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
                        *usage = u.clone();
                    }
                }
            }
        }
    }
}

fn log_usage(
    state: &Arc<AppState>,
    acc: &Account,
    model: &str,
    usage: &Value,
    latency: i64,
    ttft: i64,
    status: i64,
    ok: bool,
    ua: &str,
) {
    log_usage_by_uid(state, &acc.uid, model, usage, latency, ttft, status, ok, ua);
}

fn log_usage_by_uid(
    state: &Arc<AppState>,
    uid: &str,
    model: &str,
    usage: &Value,
    latency: i64,
    ttft: i64,
    status: i64,
    ok: bool,
    ua: &str,
) {
    let g = |k: &str| usage.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    let prompt = g("prompt_tokens");
    let completion = g("completion_tokens");
    let total = {
        let t = g("total_tokens");
        if t > 0 { t } else { prompt + completion }
    };
    let cached = usage
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    let reasoning = usage
        .get("completion_tokens_details")
        .and_then(|d| d.get("reasoning_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    // 优先使用上游返回的真实积分（credit 字段），仅字段不存在时回落到估算
    let credits = usage
        .get("credit")
        .and_then(|c| c.as_f64())
        .unwrap_or_else(|| total as f64 / 1000.0);
    let _ = state.usage.record(&RequestLog {
        ts: Utc::now().timestamp_millis(),
        uid: uid.to_string(),
        model: model.to_string(),
        session_hash: String::new(),
        source: "proxy".into(),
        prompt_tokens: prompt,
        completion_tokens: completion,
        reasoning_tokens: reasoning,
        cached_tokens: cached,
        total_tokens: total,
        credits,
        latency_ms: latency,
        ttft_ms: ttft,
        status,
        ok,
        ua: ua.to_string(),
    });
}

/// 诊断落盘：把自定义模型实际发给上游的请求（已强制 stream，不含 token）+ 上游返回内容，
/// 在命中拒绝/错误时写入 WorkMami/proxy-chat-debug.json，供真机定位 REFUSAL 等问题。
fn dump_chat_debug(req: &Value, status: u16, resp_text: &str) {
    let path = crate::platform::workmami_paths().root.join("proxy-chat-debug.json");
    let head: String = resp_text.chars().take(6000).collect();
    let obj = json!({
        "fired_at_local": Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        "status": status,
        "request": req,
        "response_text": head,
    });
    let _ = std::fs::write(&path, serde_json::to_vec_pretty(&obj).unwrap_or_default());
}

fn err_resp(code: StatusCode, msg: &str) -> Response {
    (
        code,
        Json(json!({"error": {"message": msg, "type": "proxy_error"}})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{raw_error_text, rate_notice_copy};

    #[test]
    fn raw_error_text_extracts_json_message() {
        let body = r#"{"error":{"message":"访问频率过高","type":"rate_limit_error"}}"#;
        assert_eq!(raw_error_text(body), "访问频率过高");
    }

    #[test]
    fn raw_error_text_keeps_plain_text_verbatim() {
        assert_eq!(
            raw_error_text("访问频率过高，21:35 后重试"),
            "访问频率过高，21:35 后重试"
        );
    }

    #[test]
    fn raw_error_text_keeps_json_without_message_as_is() {
        let body = r#"{"code":429}"#;
        assert_eq!(raw_error_text(body), body);
    }

    #[test]
    fn notice_copy_matches_filed_copy() {
        let (t, b) = rate_notice_copy("柏霖HK", "柏霖", "访问频率过高，21:35 后重试");
        assert_eq!(t, "已切换账号至柏霖HK");
        assert_eq!(b, "账号柏霖遇到错误：访问频率过高，21:35 后重试");
    }

    #[test]
    fn notice_copy_empty_raw_falls_back() {
        let (_, b) = rate_notice_copy("新账号", "旧账号", "   ");
        assert_eq!(b, "账号旧账号遇到错误：访问频率过高");
    }
}
