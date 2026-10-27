//! 网页授权登录（OAuth state 设备流）。
//!
//! 依据 workbuddy-switch / cockpit-tools 的真实实现：WorkBuddy 提供一组**公开**的
//! `/v2/plugin/auth/*` 端点（走 www.codebuddy.cn），基于 `state` 关联登录，**无需 Turing 设备指纹**：
//!   1. POST /v2/plugin/auth/state?platform=workbuddy → {state, authUrl}
//!   2. 打开 authUrl 让用户扫码/登录（服务端把该账号与 state 绑定）
//!   3. GET  /v2/plugin/auth/token?state= → 登录完成后返回 {accessToken, refreshToken, domain, expiresIn}
//!   4. GET  /v2/plugin/login/account?state=（带 Bearer + X-Domain）→ {uid, nickname, enterprise...}
//!     拿到的是真正的插件 Bearer accessToken，可同时驱动积分/签到接口与本地自定义模型。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chrono::Utc;

use crate::accounts;
use crate::api::ApiClient;
use crate::error::{WmError, WmResult};
use crate::state::AppState;
use crate::wbauth::AuthTokens;

/// 会话有效期（秒），与官方 OAUTH_TIMEOUT 对齐。
const OAUTH_TIMEOUT_SECONDS: i64 = 600;

/// 已抓到的登录结果。
struct Captured {
    access: String,
    refresh: String,
    domain: String,
    uid: String,
    nickname: String,
    etype: String,
    expires_at: Option<i64>,
}

struct Capture {
    state: String,
    created: i64,
    done: bool,
    captured: Option<Captured>,
    /// 本次登录用的独立浏览器子进程（外部浏览器，非 Tauri WebView）。
    child: Option<std::process::Child>,
    /// 本次登录所在的 profile 目录名（创建即定名，登录成功后写入账号表）。
    dir_name: String,
}

static CAPTURES: OnceLock<Mutex<HashMap<String, Capture>>> = OnceLock::new();
fn caps() -> &'static Mutex<HashMap<String, Capture>> {
    CAPTURES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub enum PollOutcome {
    Pending,
    Authorized(Box<accounts::Account>),
    Expired,
}

/// 发起登录：申请 state、用**完全独立的浏览器 profile**打开登录页、后台轮询 token。
///
/// 不再使用 Tauri WebView 登录窗：所有窗口共享同一 WebView2 存储，多账号会话互相污染，
/// 以前靠「整库清除 + sleep 赌异步清理完成」规避，竞态脆弱（清晚会抹掉本次登录会话）。
/// 现在每次登录分配独立 profile（browser-profiles/profile-<uuid>），在真实浏览器里
/// 扫码，登录态天然落在该 profile 内；目录名创建即固定、永不改名，拿到 uid 后只把
/// 「uid → 目录名」写进账号表（browser::ensure_profile_dir / accounts::bind_profile）。
pub async fn begin(api: Arc<ApiClient>) -> WmResult<String> {
    let (state_token, auth_url) = api.oauth_state().await?;
    let session_id = uuid::Uuid::new_v4().to_string();

    let (_label, exe) = crate::browser::detect().ok_or_else(|| {
        WmError::Other("未找到可用浏览器（Microsoft Edge 或 Google Chrome），请安装其一后重试".into())
    })?;
    let dir_name = crate::browser::new_profile_name();
    let dir = crate::browser::profiles_root().join(&dir_name);
    let child = crate::browser::launch_child(&exe, &dir, &auth_url)?;

    caps().lock().unwrap().insert(
        session_id.clone(),
        Capture {
            state: state_token.clone(),
            created: Utc::now().timestamp(),
            done: false,
            captured: None,
            child: Some(child),
            dir_name,
        },
    );

    // 后台轮询 token（与窗口无关；外部浏览器进程自行存活）
    let sid = session_id.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..(OAUTH_TIMEOUT_SECONDS / 2) {
            tokio::time::sleep(Duration::from_millis(2000)).await;
            match api.oauth_token(&state_token).await {
                Ok(Some(tok)) => {
                    // 拉账号信息
                    let acc = api.oauth_account(&state_token, &tok.access, &tok.domain).await.unwrap_or_default();
                    let uid = acc
                        .get("uid")
                        .and_then(|v| v.as_str())
                        .or_else(|| acc.get("userId").and_then(|v| v.as_str()))
                        .unwrap_or("")
                        .to_string();
                    let nickname = acc
                        .get("nickname")
                        .and_then(|v| v.as_str())
                        .or_else(|| acc.get("displayName").and_then(|v| v.as_str()))
                        .unwrap_or("")
                        .to_string();
                    let has_ent = acc.get("enterpriseId").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                        || acc.get("enterpriseName").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
                    let etype = if has_ent { "enterprise" } else { "personal" }.to_string();

                    if uid.is_empty() {
                        // 拿到 token 但取不到 uid：视为失败，结束等待
                        caps().lock().unwrap().entry(sid.clone()).and_modify(|c| c.done = true);
                        return;
                    }

                    caps().lock().unwrap().entry(sid.clone()).and_modify(|c| {
                        c.captured = Some(Captured {
                            access: tok.access.clone(),
                            refresh: tok.refresh.clone(),
                            domain: tok.domain.clone(),
                            uid,
                            nickname,
                            etype,
                            expires_at: tok.expires_at,
                        });
                    });
                    return;
                }
                Ok(None) => continue,
                Err(_) => continue,
            }
        }
        // 超时
        caps().lock().unwrap().entry(sid).and_modify(|c| c.done = true);
    });

    Ok(session_id)
}

/// 轮询登录结果。抓到后组装 token 并入库。
pub async fn poll(state: &Arc<AppState>, session_id: &str) -> WmResult<PollOutcome> {
    let captured = caps().lock().unwrap().get(session_id).and_then(|c| c.captured.as_ref().map(|cap| {
        (
            cap.access.clone(),
            cap.refresh.clone(),
            cap.domain.clone(),
            cap.uid.clone(),
            cap.nickname.clone(),
            cap.etype.clone(),
            cap.expires_at,
        )
    }));

    if let Some((access, refresh, domain, uid, nickname, etype, expires_at)) = captured {
        // 目录名创建时就已固定，这里只把「uid → 目录名」写进账号表（不改名、不迁移）。
        let dir_name = caps()
            .lock()
            .unwrap()
            .get(session_id)
            .map(|c| c.dir_name.clone())
            .unwrap_or_default();
        let tokens = AuthTokens {
            access_token: access,
            refresh_token: refresh,
            token_type: "Bearer".into(),
            expires_at,
            refresh_expires_at: None,
            scope: String::new(),
            domain: if domain.is_empty() { "www.codebuddy.cn".into() } else { domain },
            uid: uid.clone(),
        };
        let acc = accounts::upsert_from_oauth(&state.accounts, &uid, &nickname, &etype, tokens)?;
        if !dir_name.is_empty() {
            state.accounts.bind_profile(&uid, &dir_name)?;
            // 衔接体验：同一 profile 里打开成长计划（浏览器若仍开着则新开标签页）
            let _ = crate::browser::open_growth_in(&crate::browser::profiles_root().join(&dir_name));
        }
        // 清理，避免重复入库
        let mut m = caps().lock().unwrap();
        if let Some(c) = m.get_mut(session_id) {
            c.done = true;
            c.captured = None;
            c.child = None; // 句柄移交完毕；浏览器窗口留给用户继续使用
        }
        return Ok(PollOutcome::Authorized(Box::new(acc)));
    }

    // 会话失败/过期：若登录浏览器已被用户关闭，顺手清掉这次没用上的 profile 目录；
    // 浏览器还开着则保留（避免删运行中目录），交给后台闲置回收在浏览器退出后处理。
    {
        let expired = {
            let m = caps().lock().unwrap();
            m.get(session_id)
                .map(|c| c.done || Utc::now().timestamp() - c.created > OAUTH_TIMEOUT_SECONDS)
                .unwrap_or(true)
        };
        if expired {
            let mut m = caps().lock().unwrap();
            if let Some(c) = m.get_mut(session_id) {
                c.done = true;
                let exited = match c.child.as_mut() {
                    Some(child) => child.try_wait().map(|s| s.is_some()).unwrap_or(false),
                    None => true,
                };
                if exited {
                    c.child = None;
                    // 已写入账号表的目录属于正式 profile，绝不回收
                    let bound = state
                        .accounts
                        .all()
                        .iter()
                        .any(|a| a.profile.as_deref() == Some(c.dir_name.as_str()));
                    if !bound {
                        let _ = std::fs::remove_dir_all(crate::browser::profiles_root().join(&c.dir_name));
                    }
                }
            }
            return Ok(PollOutcome::Expired);
        }
    }
    Ok(PollOutcome::Pending)
}

/// 仍在进行中的登录 profile 目录名，供后台闲置回收避让。
pub fn active_profile_dirs() -> Vec<String> {
    caps()
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, c)| !c.done)
        .map(|(_, c)| c.dir_name.clone())
        .collect()
}
