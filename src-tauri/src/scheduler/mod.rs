//! 定时任务：周期性刷新积分 + 每日自动签到 + 猫猫旅行自动托管。同时暴露给命令层手动触发。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use chrono::{DateTime, Local, Timelike, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio_cron_scheduler::{Job, JobScheduler};

use crate::accounts::{self, QuotaSnapshot};
use crate::api::should_refresh;
use crate::error::WmResult;
use crate::platform::workmami_paths;
use crate::state::AppState;

/// 单个账号刷新结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub uid: String,
    pub nickname: String,
    pub ok: bool,
    pub quota: Option<QuotaSnapshot>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckinResult {
    pub uid: String,
    pub nickname: String,
    pub ok: bool,
    pub reward: f64,
    pub already: bool,
    pub streak: i64,
    pub message: String,
}

/// 刷新所有（或指定）账号的积分余额。
pub async fn refresh_quota(state: Arc<AppState>, uids: Option<Vec<String>>) -> Vec<RefreshResult> {
    let accounts = state.accounts.all();
    let mut out = Vec::new();
    for acc in accounts {
        if let Some(list) = &uids {
            if !list.contains(&acc.uid) {
                continue;
            }
        }
        let tokens = match accounts::load_token(&acc.uid) {
            Some(t) => t,
            None => {
                out.push(RefreshResult {
                    uid: acc.uid,
                    nickname: acc.nickname,
                    ok: false,
                    quota: None,
                    error: Some("无本地凭证，需重新授权".into()),
                });
                continue;
            }
        };
        // 过期先刷新
        let tokens = if should_refresh(&tokens) && !tokens.refresh_token.is_empty() {
            match state.api.refresh_token(&tokens).await {
                Ok(nt) => {
                    let _ = accounts::store_token(&acc.uid, &nt);
                    nt
                }
                Err(_) => tokens,
            }
        } else {
            tokens
        };
        match state.api.fetch_quota(&tokens).await {
            Ok(mut q) => {
                if let Ok(st) = state.api.fetch_status(&tokens).await {
                    let plan = st
                        .get("data")
                        .and_then(|d| d.get("planTierName").or(d.get("plan")))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    q.plan = plan;
                }
                let _ = state.accounts.update_quota(&acc.uid, q.clone());
                state.record_balance(&acc.uid, q.remaining);
                out.push(RefreshResult { uid: acc.uid, nickname: acc.nickname, ok: true, quota: Some(q), error: None });
            }
            Err(e) => out.push(RefreshResult {
                uid: acc.uid,
                nickname: acc.nickname,
                ok: false,
                quota: None,
                error: Some(e.to_string()),
            }),
        }
    }
    out
}

/// 对全部启用账号执行签到。
pub async fn checkin_all(state: Arc<AppState>) -> Vec<CheckinResult> {
    let accounts = state.accounts.enabled_accounts();
    let mut out = Vec::new();
    for acc in accounts {
        out.push(checkin_one(state.clone(), &acc.uid).await);
    }
    out
}

pub async fn checkin_one(state: Arc<AppState>, uid: &str) -> CheckinResult {
    let nickname = state.accounts.get(uid).map(|a| a.nickname).unwrap_or_default();
    let tokens = match accounts::load_token(uid) {
        Some(t) => t,
        None => {
            return CheckinResult {
                uid: uid.to_string(),
                nickname,
                ok: false,
                reward: 0.0,
                already: false,
                streak: 0,
                message: "无本地凭证，需重新授权".into(),
            }
        }
    };
    let tokens = if should_refresh(&tokens) && !tokens.refresh_token.is_empty() {
        match state.api.refresh_token(&tokens).await {
            Ok(nt) => {
                let _ = accounts::store_token(uid, &nt);
                nt
            }
            Err(_) => tokens,
        }
    } else {
        tokens
    };

    // 先查状态，避免重复
    let (checked, streak, _) = state.api.fetch_checkin_status(&tokens).await.unwrap_or((false, 0, serde_json::Value::Null));
    if checked {
        let _ = state.accounts.update_checkin(uid, true, streak);
        return CheckinResult { uid: uid.to_string(), nickname, ok: true, reward: 0.0, already: true, streak, message: "今日已签到".into() };
    }

    // 签到前余额快照：签到成功响应体未必含“到账积分”字段（WorkBuddy 不用通用键名），
    // 故用签到前后余额差反推本次实际到账，比解析响应字段更可靠。
    let before = state.api.fetch_quota(&tokens).await.ok().map(|q| q.remaining);

    match state.api.do_checkin(&tokens).await {
        Ok((ok, reward, raw)) => {
            // 检测"已签到"（code 10001 或消息含"已签到"）
            let already_in_raw = raw.get("code").and_then(|c| c.as_i64()) == Some(10001)
                || raw.get("msg").and_then(|m| m.as_str()).map(|s| s.contains("已签到")).unwrap_or(false);
            if already_in_raw {
                let _ = state.accounts.update_checkin(uid, true, streak);
                return CheckinResult { uid: uid.to_string(), nickname, ok: true, reward: 0.0, already: true, streak, message: "今日已签到".into() };
            }
            if ok {
                let _ = state.accounts.update_checkin(uid, true, streak + 1);
            }
            // 反推本次到账：优先用余额差（>0.5 才认，滤掉浮点噪声），否则回落响应解析值。
            let mut gained = reward;
            if ok {
                if let Some(nq) = state.api.fetch_quota(&tokens).await.ok() {
                    let _ = state.accounts.update_quota(uid, nq.clone());
                    state.record_balance(uid, nq.remaining);
                    if let Some(b) = before {
                        let d = nq.remaining - b;
                        if d > 0.5 {
                            gained = d;
                        }
                    }
                }
            }
            let gained = (gained * 100.0).round() / 100.0;
            CheckinResult {
                uid: uid.to_string(),
                nickname,
                ok,
                reward: gained,
                already: false,
                streak: streak + if ok { 1 } else { 0 },
                message: if ok { format!("签到成功 +{gained}") } else { "签到失败".into() },
            }
        }
        Err(e) => CheckinResult {
            uid: uid.to_string(),
            nickname,
            ok: false,
            reward: 0.0,
            already: false,
            streak,
            message: e.to_string(),
        },
    }
}

/// 启动调度器：每 10 分钟刷新积分；每日到点自动签到；每 5 分钟旅行托管。
pub async fn start(app: AppHandle, state: Arc<AppState>) -> WmResult<JobScheduler> {
    let sched = JobScheduler::new().await?;

    // 积分刷新：每 10 分钟
    {
        let st = state.clone();
        let job = Job::new_async("0 0/10 * * * *", move |_uuid, _l| {
            let st = st.clone();
            Box::pin(async move {
                let _ = refresh_quota(st, None).await;
            })
        })?;
        sched.add(job).await?;
    }

    // 自动签到：每分钟 tick 一次。启用后，每个账号在每天 01:00~06:00 之间被分配一个
    // 确定性随机时刻（基于 uid + 日期 hash，同日同一账号固定，跨天不同）。到点后首个 tick
    // 触发该账号签到；即使 App 未在分配时刻正好开着，之后打开也会补签当天这次。
    {
        let st = state.clone();
        let job = Job::new_async("0 * * * * *", move |_uuid, _l| {
            let st = st.clone();
            Box::pin(async move {
                let auto_enabled = st.settings.read().unwrap().checkin.auto_enabled;
                if !auto_enabled {
                    return;
                }
                let now = Local::now();
                let today = now.format("%Y-%m-%d").to_string();
                let now_min = now.hour() * 60 + now.minute(); // 当日分钟数
                let window_start = 1u32 * 60; // 01:00
                let window_end = 6u32 * 60;   // 06:00
                if now_min < window_start {
                    return; // 还没到最早触发窗口，直接等下个 tick
                }

                let accounts = st.accounts.enabled_accounts();
                let mut fired_any = false;
                let mut fired_results: Vec<_> = Vec::new();
                // 候选账号：今日未签 & 已到各自时刻
                let mut to_fire: Vec<String> = Vec::new();
                {
                    let done_map = st.auto_checkin_done.lock().unwrap();
                    for acc in &accounts {
                        if done_map.get(&acc.uid).map(|d| d.as_str()) == Some(today.as_str()) {
                            continue;
                        }
                        let target_min = random_minute_in_window(&acc.uid, &today, window_start, window_end);
                        if now_min >= target_min {
                            to_fire.push(acc.uid.clone());
                        }
                    }
                }
                // 锁已释放，可以安全地在下面的 loop 里 .await
                for uid in &to_fire {
                    let r = checkin_one(st.clone(), uid).await;
                    fired_any = fired_any || (r.ok && !r.already);
                    fired_results.push(r);
                }
                if !to_fire.is_empty() {
                    let mut done_map = st.auto_checkin_done.lock().unwrap();
                    for uid in &to_fire {
                        done_map.insert(uid.clone(), today.clone());
                    }
                }

                if !fired_results.is_empty() {
                    if fired_any {
                        let _ = refresh_quota(st.clone(), None).await;
                    }
                    let summary: Vec<_> = fired_results
                        .iter()
                        .map(|r| {
                            serde_json::json!({
                                "uid": r.uid,
                                "nickname": r.nickname,
                                "ok": r.ok,
                                "already": r.already,
                                "reward": r.reward,
                                "streak": r.streak,
                            })
                        })
                        .collect();
                    let marker = serde_json::json!({
                        "fired_at_local": now.format("%Y-%m-%d %H:%M:%S").to_string(),
                        "window": "01:00-06:00",
                        "checked_in_now": fired_any,
                        "results": summary,
                    });
                    let _ = std::fs::write(
                        workmami_paths().root.join("checkin-scheduler-debug.json"),
                        serde_json::to_vec_pretty(&marker).unwrap_or_default(),
                    );
                }
            })
        })?;
        sched.add(job).await?;
    }

    // 猫猫旅行自动托管：每 10 分钟 tick 一次。每个账号在每天 01:00~06:00 之间被分配一个
    // 确定性随机时刻（基于 uid + 日期 hash，同日固定、跨天不同），到点后首个 tick 才派猫；
    // 01:00 之前不派（避免午夜整点动作）。到达/领奖仍按 tick 频率巡检，当日熔断后不再调用官方接口。
    {
        let st = state.clone();
        let handle = app.clone();
        let job = Job::new_async("0 */10 * * * *", move |_uuid, _l| {
            let st = st.clone();
            let handle = handle.clone();
            Box::pin(async move {
                travel_tick(handle, st).await;
            })
        })?;
        sched.add(job).await?;
    }

    sched.start().await?;
    Ok(sched)
}

/// 根据 uid + 日期生成一个落在 [start_min, end_min) 区间内的确定性分钟数。
/// 同日同一账号得到的时刻固定，跨天自然不同；用 DefaultHasher 确保无额外依赖。
fn random_minute_in_window(uid: &str, day: &str, start_min: u32, end_min: u32) -> u32 {
    let mut h = DefaultHasher::new();
    uid.hash(&mut h);
    day.hash(&mut h);
    let hash = h.finish();
    let span = (end_min - start_min).max(1);
    start_min + (hash % span as u64) as u32
}

/// 猫猫旅行自动托管 tick（每 60 分钟一次）：
/// - arrived → 自动领取 + 通知
/// - idle + auto_enabled → 自动派猫（按策略选地点）
/// - traveling → 记录到 seen_traveling（用于区分在线到点 vs 离线到点）
/// 当日熔断：连续 3 次确认“所有账号都 idle+今日已达上限”后，将今日标记为完成，
/// 之后当日不再调用任何官方接口（避免高频轮询触发账号风控）；次日自动恢复。
async fn travel_tick(app: AppHandle, state: Arc<AppState>) {
    let today = Local::now().format("%Y-%m-%d").to_string();
    // 熔断早退：今日已确认全部账号达上限，直接返回，不发起任何官方请求。
    if *state.travel_done_date.lock().unwrap() == today {
        let marker = serde_json::json!({
            "fired_at_local": Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            "skipped": "daily_circuit_breaker（今日已达上限，不再轮询官方接口）",
        });
        let _ = std::fs::write(
            workmami_paths().root.join("travel-scheduler-debug.json"),
            serde_json::to_vec_pretty(&marker).unwrap_or_default(),
        );
        return;
    }

    let auto_enabled = state.settings.read().unwrap().travel.auto_enabled;
    let policy = state.settings.read().unwrap().travel.location_policy.clone();
    let mut actions: Vec<serde_json::Value> = Vec::new();
    // 本轮是否“所有已查账号都今日完工”（idle+达上限）；任何 traveling/arrived/可派发/查询失败都会置 false。
    let mut all_done = true;
    let mut any_queried = false;

    let enabled = state.accounts.enabled_accounts();
    // 拿一个 token 获取地点配置（缓存一次即可）
    let tokens_first = enabled.iter().find_map(|a| accounts::load_token(&a.uid));
    let locations = match &tokens_first {
        Some(t) => state.api.buddy_travel_config(t).await.unwrap_or_default(),
        None => return,
    };

    for acc in &enabled {
        let Some(tokens) = accounts::load_token(&acc.uid) else {
            continue;
        };
        any_queried = true;
        let status = match state.api.buddy_travel_status(&tokens).await {
            Ok(s) => s,
            Err(e) => {
                all_done = false; // 查询失败不能当作完工，保留下一轮重试
                actions.push(serde_json::json!({"uid": acc.uid, "action": "status_failed", "error": e.to_string()}));
                continue;
            }
        };

        match status.state.as_str() {
            "arrived" => {
                all_done = false;
                // 自动领取
                match state.api.buddy_travel_claim(&tokens).await {
                    Ok(_) => {
                        actions.push(serde_json::json!({"uid": acc.uid, "action": "claimed"}));
                        let _ = app.emit("travel-claimed", serde_json::json!({
                            "uid": acc.uid,
                            "nickname": acc.nickname,
                        }));
                        let _ = app.notification().builder()
                            .title("猫猫旅行")
                            .body(format!("{}的猫猫旅行已结束，奖励已自动领取", acc.nickname))
                            .show();
                    }
                    Err(e) => {
                        actions.push(serde_json::json!({"uid": acc.uid, "action": "claim_failed", "error": e.to_string()}));
                        tracing::warn!("旅行领取失败({}): {e}", acc.uid);
                    }
                }
            }
            "traveling" => {
                all_done = false;
                // 记录本会话看到过旅行中
                state.travel_seen_traveling.lock().unwrap().insert(acc.uid.clone());
                actions.push(serde_json::json!({"uid": acc.uid, "action": "none", "state": "traveling"}));
            }
            "idle" if auto_enabled && !locations.is_empty() => {
                if status.daily_limit_reached {
                    // 服务端判定今日旅行次数已用完：此账号今日完工（保持 all_done 不变）。
                    actions.push(serde_json::json!({"uid": acc.uid, "action": "skip_daily_limit"}));
                    let _ = app.emit("travel-skip-limit", serde_json::json!({
                        "uid": acc.uid,
                        "nickname": acc.nickname,
                    }));
                } else {
                    // 派猫时机门控：01:00 之前不派（避免午夜整点动作）；每个号在 01:00~06:00
                    // 之间被分配一个确定性随机时刻，到点后首个 tick 才派。
                    let now_min = Local::now().hour() * 60 + Local::now().minute();
                    let window_start = 1u32 * 60; // 01:00
                    if now_min < window_start {
                        all_done = false;
                        actions.push(serde_json::json!({"uid": acc.uid, "action": "wait_before_window", "note": "01:00 前不派猫"}));
                    } else {
                        let target_min = random_minute_in_window(&acc.uid, &today, window_start, 6u32 * 60);
                        if now_min < target_min {
                            all_done = false;
                            actions.push(serde_json::json!({"uid": acc.uid, "action": "wait_dispatch_time", "target_min": target_min}));
                        } else {
                            // 还能派猫 → 今日未完工；自动派猫
                            all_done = false;
                            let loc = select_location(&locations, &policy, &acc.uid, &state);
                            if let Some(loc) = loc {
                                let dep = state.api.buddy_travel_depart(&tokens, loc.id).await;
                                match dep {
                                    Ok(_) => {
                                        actions.push(serde_json::json!({"uid": acc.uid, "action": "departed", "location": loc.name}));
                                        state.travel_seen_traveling.lock().unwrap().insert(acc.uid.clone());
                                        let _ = app.emit("travel-departed", serde_json::json!({
                                            "uid": acc.uid,
                                            "nickname": acc.nickname,
                                            "location": loc.name,
                                        }));
                                    }
                                    Err(e) => {
                                        actions.push(serde_json::json!({"uid": acc.uid, "action": "depart_failed", "error": e.to_string()}));
                                        tracing::warn!("自动派猫失败({}): {e}", acc.uid);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            other => {
                all_done = false;
                actions.push(serde_json::json!({"uid": acc.uid, "action": "none", "state": other}));
            }
        }
    }

    // 熔断计数：本轮若所有已查账号都完工，连累加；连续达 3 次则今日熍断（防单次偶发误判）。
    let streak_now = {
        let mut streak = state.travel_limit_streak.lock().unwrap();
        if any_queried && all_done {
            *streak += 1;
        } else {
            *streak = 0;
        }
        *streak
    };
    if any_queried && all_done && streak_now >= 3 {
        *state.travel_done_date.lock().unwrap() = today.clone();
        actions.push(serde_json::json!({"action": "circuit_breaker_tripped", "date": today}));
    }

    // 落一份巡检标记（同 checkin-scheduler-debug 的思路）：真机排查“为什么没自动出发”直接看它。
    let marker = serde_json::json!({
        "fired_at_local": Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        "auto_enabled": auto_enabled,
        "policy": policy,
        "locations": locations.len(),
        "all_done": any_queried && all_done,
        "limit_streak": streak_now,
        "done_today": *state.travel_done_date.lock().unwrap(),
        "actions": actions,
    });
    let _ = std::fs::write(
        workmami_paths().root.join("travel-scheduler-debug.json"),
        serde_json::to_vec_pretty(&marker).unwrap_or_default(),
    );
}

/// 根据策略选择旅行地点。
fn select_location(
    locations: &[crate::api::TravelLocation],
    policy: &str,
    uid: &str,
    state: &Arc<AppState>,
) -> Option<crate::api::TravelLocation> {
    if locations.is_empty() {
        return None;
    }
    match policy {
        "shortest" => locations.iter().min_by(|a, b| {
            a.duration_max_hours.partial_cmp(&b.duration_max_hours).unwrap_or(std::cmp::Ordering::Equal)
        }),
        "rotate" => {
            let mut rotate = state.travel_rotate.lock().unwrap();
            let idx = rotate.entry(uid.to_string()).or_insert(0);
            let loc = locations.get(*idx % locations.len());
            *idx = idx.wrapping_add(1);
            loc
        }
        _ => {
            // longest (default)
            locations.iter().max_by(|a, b| {
                a.duration_max_hours.partial_cmp(&b.duration_max_hours).unwrap_or(std::cmp::Ordering::Equal)
            })
        }
    }
    .cloned()
}

/// 计算距下次刷新的秒数（前端展示用）。
pub fn next_refresh_in(last: Option<DateTime<Utc>>) -> i64 {
    match last {
        Some(t) => {
            let elapsed = Utc::now().signed_duration_since(t).num_seconds();
            (600 - elapsed).max(0)
        }
        None => 0,
    }
}
