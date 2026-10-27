//! 成长计划人工操作窗口：为每个账号拉起一个**独立浏览器 profile**。
//!
//! 背景：WorkMami 只保存插件 Bearer token（供 /v2/plugin、/billing 等 JSON 接口），
//! 不持有网页 cookie 会话；成长计划 SPA（www.codebuddy.cn/profile/growth-space）
//! 靠浏览器自身登录态判定身份，插件 token 无法注入网页。因此给每个 uid 分配独立的
//! `--user-data-dir`，由浏览器自己保存该账号的网页登录。
//!
//! 门禁：只有当独立目录里检测到网页登录态（workbuddy.cn / codebuddy.cn 的 cookie），
//! 才允许直接「打开成长计划」；未记忆的账号拒绝启动，要求先「登录/记忆」（重新扫码）。

use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::accounts::AccountStore;
use crate::api::GROWTH_CENTER_URL;
use crate::error::{WmError, WmResult};
use crate::platform::workmami_paths;

/// 账号专属浏览器 profile 根目录：<数据目录>/browser-profiles。
pub fn profiles_root() -> PathBuf {
    workmami_paths().root.join("browser-profiles")
}

/// 为一次登录分配一个永久固定的 profile 目录名：profile-<uuid>。
/// 名字在创建目录的那一刻确定，此后永世不再改动；uid 与目录名的对应关系存在账号表里。
pub fn new_profile_name() -> String {
    format!("profile-{}", uuid::Uuid::new_v4())
}

/// 已定名的 profile 目录；账号从未登录过（账号表里无映射）返回 None。
pub fn profile_dir(store: &AccountStore, uid: &str) -> Option<PathBuf> {
    store.profile_name(uid).map(|name| profiles_root().join(name))
}

/// 取该账号的 profile 目录；首次使用时分配固定名字并写入账号表（创建即定名）。
pub fn ensure_profile_dir(store: &AccountStore, uid: &str) -> WmResult<PathBuf> {
    if let Some(dir) = profile_dir(store, uid) {
        std::fs::create_dir_all(&dir)?;
        return Ok(dir);
    }
    let name = new_profile_name();
    let dir = profiles_root().join(&name);
    std::fs::create_dir_all(&dir)?;
    store.bind_profile(uid, &name)?;
    Ok(dir)
}

/// 闲置回收：删除不属于任何账号、也不属于进行中登录会话的 profile 目录。
///
/// 仅由后台定时任务在应用运行期间调用（启动时不执行），因此不会与刚发起的登录抢跑；
/// 被浏览器占用的目录删除会失败，直接跳过，等浏览器退出后的下一轮再回收。
pub fn cleanup_idle_profile_dirs(known_dirs: &[String], active_dirs: &[String]) {
    let root = profiles_root();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if active_dirs.iter().any(|d| d == &name) || known_dirs.iter().any(|d| d == &name) {
            continue;
        }
        // 1 分钟内新建的目录先放过，避免和刚发起但尚未登记完的登录冲突
        let fresh = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|d| d.as_secs() < 60)
            .unwrap_or(false);
        if fresh {
            continue;
        }
        let _ = std::fs::remove_dir_all(entry.path());
    }
}

struct BrowserCandidate {
    label: &'static str,
    exe: PathBuf,
}

/// 按优先级列出候选浏览器可执行文件（调用方再判存在）。
fn candidates() -> Vec<BrowserCandidate> {
    let mut v = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let pf = std::env::var("ProgramFiles").ok();
        let pf_x86 = std::env::var("ProgramFiles(x86)").ok();
        let local = std::env::var("LOCALAPPDATA").ok();

        // Edge：Windows 系统自带，优先
        for base in pf_x86.iter().chain(pf.iter()) {
            v.push(BrowserCandidate {
                label: "Microsoft Edge",
                exe: PathBuf::from(base).join("Microsoft/Edge/Application/msedge.exe"),
            });
        }
        // Chrome：系统目录 + 用户目录
        for base in pf.iter().chain(pf_x86.iter()).chain(local.iter()) {
            v.push(BrowserCandidate {
                label: "Google Chrome",
                exe: PathBuf::from(base).join("Google/Chrome/Application/chrome.exe"),
            });
        }
    }

    #[cfg(target_os = "macos")]
    {
        v.push(BrowserCandidate {
            label: "Google Chrome",
            exe: PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        });
        v.push(BrowserCandidate {
            label: "Microsoft Edge",
            exe: PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        });
    }

    v
}

/// 探测第一个实际存在的浏览器，返回（展示名, 可执行路径）。
pub fn detect() -> Option<(&'static str, PathBuf)> {
    candidates()
        .into_iter()
        .find(|c| c.exe.is_file())
        .map(|c| (c.label, c.exe))
}

/// Chromium profile 内 cookie 库候选位置（新版在 Network/，旧版直接在 Default/）。
fn cookie_files(dir: &Path) -> Vec<PathBuf> {
    let default = dir.join("Default");
    vec![
        default.join("Network").join("Cookies"),
        default.join("Cookies"),
    ]
}

/// 只读查询 cookie 库中目标域记录数；打不开/无表返回 None（交由调用方回落）。
fn target_cookie_count(path: &PathBuf) -> Option<i64> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    conn.query_row(
        "SELECT COUNT(*) FROM cookies \
         WHERE host_key LIKE '%workbuddy.cn%' OR host_key LIKE '%codebuddy.cn%'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .ok()
}

/// 是否已在独立目录中保存网页登录态（检测目标域 cookie）。
pub fn is_bound(store: &AccountStore, uid: &str) -> bool {
    let Some(dir) = profile_dir(store, uid) else {
        return false;
    };
    if !dir.exists() {
        return false;
    }
    for f in cookie_files(&dir) {
        if !f.is_file() {
            continue;
        }
        match target_cookie_count(&f) {
            // 查到目标域 cookie → 已记忆
            Some(n) if n > 0 => return true,
            // 库可读但无目标域 cookie → 继续看下一个候选文件
            Some(_) => continue,
            // 库被锁/读不了 → 回落：文件非空视为已有会话（避免误拒）
            None => {
                if let Ok(meta) = std::fs::metadata(&f) {
                    if meta.len() > 0 {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// 用独立 profile 打开指定 URL；返回浏览器子进程句柄（spawn 后不等待）。
pub fn launch_child(exe: &PathBuf, dir: &PathBuf, url: &str) -> WmResult<std::process::Child> {
    std::fs::create_dir_all(dir)?;
    Command::new(exe)
        .arg(format!("--user-data-dir={}", dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(url)
        .spawn()
        .map_err(WmError::from)
}

/// 用独立 profile 拉起浏览器直达成长计划；spawn 后不等待，浏览器独立运行。
fn launch(label: &str, exe: &PathBuf, dir: &PathBuf) -> WmResult<Value> {
    launch_child(exe, dir, GROWTH_CENTER_URL)?;
    Ok(serde_json::json!({
        "browser": label,
        "profileDir": dir.to_string_lossy().into_owned(),
        "url": GROWTH_CENTER_URL,
    }))
}

/// 在指定 profile 目录中打开成长计划（OAuth 登录成功后自动衔接；
/// 若该 profile 的浏览器仍在运行，只会在既有窗口里新开一个标签页）。
pub fn open_growth_in(dir: &PathBuf) -> WmResult<Value> {
    let (label, exe) = detect().ok_or_else(|| {
        WmError::Other("未找到可用浏览器（Microsoft Edge 或 Google Chrome），请安装其一后重试".into())
    })?;
    launch(label, &exe, dir)
}

/// 直接打开成长计划：仅当已记忆网页登录态才放行；未记忆**不启动浏览器**，
/// 返回 `{bound:false, reason}` 由前端提示用户先退出并重新登录（扫码记忆）。
pub fn open_growth_center(store: &AccountStore, uid: &str) -> WmResult<Value> {
    if !is_bound(store, uid) {
        return Ok(serde_json::json!({
            "bound": false,
            "reason": "该账号尚未记忆成长计划登录态，请先退出账号并重新登录（在独立窗口扫码一次）后再打开",
        }));
    }
    let (label, exe) = detect().ok_or_else(|| {
        WmError::Other("未找到可用浏览器（Microsoft Edge 或 Google Chrome），请安装其一后重试".into())
    })?;
    let dir = ensure_profile_dir(store, uid)?;
    let mut v = launch(label, &exe, &dir)?;
    v["bound"] = serde_json::json!(true);
    Ok(v)
}

/// 登录/记忆：不校验状态，直接拉起独立窗口供扫码建立登录态
/// （即“退出账号重新登录”的实际落点），成功后该目录即被记忆。
pub fn bind_growth_center(store: &AccountStore, uid: &str) -> WmResult<Value> {
    let (label, exe) = detect().ok_or_else(|| {
        WmError::Other("未找到可用浏览器（Microsoft Edge 或 Google Chrome），请安装其一后重试".into())
    })?;
    let dir = ensure_profile_dir(store, uid)?;
    let mut v = launch(label, &exe, &dir)?;
    v["bound"] = serde_json::json!(false);
    Ok(v)
}
