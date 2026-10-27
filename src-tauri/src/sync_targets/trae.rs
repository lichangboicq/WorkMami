//! TRAE IDE 同步：把模型池虚拟条目写入 TRAE 的自定义模型存储。
//! TRAE（VSCode 分叉）没有明文配置文件，自定义模型存在 SQLite：
//!   %APPDATA%\Trae CN\User\globalStorage\state.vscdb
//!   键 `<uid>:AI.agent.model.model_list_map` → { <场景>: [模型条目...] }
//! 自定义条目特征：is_preset=false + base_url/ak 指向本地代理。
//! TRAE 运行时数据库被锁，只读可通行、写入会 BUSY——此时报友好提示让用户退出 TRAE。

use std::path::PathBuf;

use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Map, Value, json};

use crate::error::WmError;
use crate::state::ProxySettings;

use super::{IdeSyncTarget, ManualField, ManualGuideJson, R};

/// 模型列表存储键后缀（按用户 uid 前缀区分，用 LIKE 匹配）
const KEY_SUFFIX: &str = ":AI.agent.model.model_list_map";
/// 注入的模型数组白名单：本地 IDE 场景（远程 Solo 场景访问不到 localhost，不注入）
const ARRAYS: [&str; 3] = ["solo_agent", "solo_agent_lite", "agent"];

fn storage_dir() -> Option<PathBuf> {
    let base = dirs::data_dir()?;
    for name in ["Trae CN", "Trae"] {
        let dir = base.join(name).join("User").join("globalStorage");
        if dir.exists() {
            return Some(dir);
        }
    }
    None
}

fn db_path(dir: &PathBuf) -> PathBuf {
    dir.join("state.vscdb")
}

fn proxy_base_url(ps: &ProxySettings) -> String {
    let display_host = if ps.host == "0.0.0.0" { "127.0.0.1" } else { ps.host.as_str() };
    format!("http://{display_host}:{}/v1", ps.port)
}

/// 读取模型列表 JSON（Map<场景, [条目]>）。键不存在 → None（TRAE 从未登录/未拉取过模型列表）。
fn load_map(conn: &Connection) -> R<Option<(String, Map<String, Value>)>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key LIKE ? LIMIT 1",
            params![format!("%{KEY_SUFFIX}")],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    let Some(raw) = raw else { return Ok(None) };
    let v: Value = serde_json::from_str(&raw)?;
    Ok(v.as_object().map(|m| (raw, m.clone())))
}

/// 把 TRAE 数据库占用错误转成用户可理解的提示
fn friendly_db_err(e: rusqlite::Error) -> WmError {
    let busy = matches!(
        &e,
        rusqlite::Error::SqliteFailure(ffi, _)
            if ffi.code == rusqlite::ErrorCode::DatabaseBusy
                || ffi.code == rusqlite::ErrorCode::DatabaseLocked
    );
    if busy {
        WmError::Other("TRAE 正在运行，请先退出 TRAE 再同步".into())
    } else {
        WmError::Db(e)
    }
}

/// 由模板条目克隆出 WorkMami 池的自定义模型条目（模板缺失时从空对象起步）。
/// name 用池 id（请求时的模型名），display_name 用池展示名。
fn build_entry(ps: &ProxySettings, template: Option<&Value>, pool: &Value, url: &str) -> Value {
    let id = pool.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let name = pool.get("name").and_then(|v| v.as_str()).unwrap_or(&id).to_string();
    let mut obj = template
        .and_then(|t| t.as_object().cloned())
        .unwrap_or_else(Map::new);
    for (k, v) in [
        ("name", json!(id)),
        ("display_name", json!(name)),
        ("config_name", json!(id)),
        ("is_preset", json!(false)),
        ("is_default", json!(false)),
        ("is_new", json!(false)),
        ("is_beta", json!(false)),
        ("status", json!(true)),
        ("selectable", json!(true)),
        ("base_url", json!(url)),
        ("is_custom_base_url", json!(true)),
        ("custom_model_type", json!(1)),
        ("provider", json!("")),
        ("ak", json!(ps.api_key)),
        ("sk", json!("")),
        ("auth_type", json!(0)),
        ("use_remote_service", json!(false)),
        ("icon", json!({})),
        ("tags", json!([])),
        ("managedBy", json!("WorkMami")),
    ] {
        obj.insert(k.into(), v);
    }
    Value::Object(obj)
}

pub struct TraeTarget;

impl IdeSyncTarget for TraeTarget {
    fn id(&self) -> &'static str {
        "trae"
    }

    fn label(&self) -> &'static str {
        "TRAE"
    }

    fn detect(&self) -> Option<PathBuf> {
        storage_dir()
    }

    fn sync(&self, ps: &ProxySettings, _models: &[Value]) -> R<usize> {
        let Some(dir) = storage_dir() else { return Ok(0) };
        run_sync(&db_path(&dir), ps)
    }

    fn is_synced(&self, ps: &ProxySettings) -> bool {
        let Some(dir) = storage_dir() else { return false };
        synced_at(&db_path(&dir), ps)
    }

    fn manual_guide(&self) -> Option<ManualGuideJson> {
        Some(ManualGuideJson {
            title: "在 TRAE 中手动添加 WorkMami 自定义模型".into(),
            subtitle: "TRAE 未检测到安装目录、正在运行或自动同步失败时，可按以下步骤手动添加".into(),
            fields: vec![
                ManualField { label: "API 格式".into(), value: "OpenAI Chat Completions".into(), copy: false },
                ManualField { label: "自定义请求地址".into(), value: "http://127.0.0.1:8765/v1".into(), copy: true },
                ManualField { label: "模型 ID".into(), value: "文员（与模型池名称一致）".into(), copy: true },
                ManualField { label: "API 密钥".into(), value: "（在 WorkMami 设置 → 自定义模型里复制）".into(), copy: false },
            ],
            footer: "设置 → 模型 → 添加模型 → 自定义配置；接口地址中的 8765 请替换为你实际配置的自定义模型端口".into(),
        })
    }
}

/// 对指定数据库执行同步（抽出以便测试）。
fn run_sync(db: &std::path::Path, ps: &ProxySettings) -> R<usize> {
    let conn = Connection::open(db).map_err(friendly_db_err)?;
    let Some((raw, mut map)) = load_map(&conn)? else {
        tracing::info!("TRAE sync: 未找到模型列表存储键（TRAE 未登录或未拉取过模型），跳过");
        return Ok(0);
    };

    let url = proxy_base_url(ps);
    let pools = crate::proxy::pools::pool_entries(ps, &url, &ps.api_key);
    let mut written = 0usize;

    for scene in ARRAYS {
        let Some(arr) = map.get_mut(scene).and_then(|v| v.as_array_mut()) else { continue };
        // 只清理自己 managedBy 标记的条目
        let kept: Vec<Value> = arr
            .iter()
            .filter(|e| e.get("managedBy").and_then(|v| v.as_str()) != Some("WorkMami"))
            .cloned()
            .collect();
        let removed = arr.len() - kept.len();
        if pools.is_empty() && removed == 0 {
            *arr = kept;
            continue;
        }
        let template = kept.first().cloned();
        let ours: Vec<Value> =
            pools.iter().map(|p| build_entry(ps, template.as_ref(), p, &url)).collect();
        written += ours.len() + removed;
        *arr = kept;
        arr.extend(ours);
    }

    if written == 0 {
        return Ok(0);
    }

    // 内容无变化（重复同步）→ 不写盘，避免 TRAE 运行期间无谓触发数据库占用
    let bytes = serde_json::to_string(&Value::Object(map))?;
    if bytes == raw {
        return Ok(0);
    }
    conn.execute(
        "UPDATE ItemTable SET value = ? WHERE key LIKE ?",
        params![bytes, format!("%{KEY_SUFFIX}")],
    )
    .map_err(friendly_db_err)?;
    drop(conn);
    tracing::info!("TRAE sync: 写入 {written} 条自定义模型条目（{ARRAYS:?}）");
    Ok(written)
}

/// 磁盘上是否已存在与当前代理配置一致的托管条目（抽出以便测试）。
fn synced_at(db: &std::path::Path, ps: &ProxySettings) -> bool {
    let Ok(conn) = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    let Ok(Some((_, map))) = load_map(&conn) else { return false };
    let url = proxy_base_url(ps);
    ARRAYS.iter().any(|scene| {
        map.get(*scene).and_then(|v| v.as_array()).is_some_and(|arr| {
            arr.iter().any(|e| {
                e.get("managedBy").and_then(|v| v.as_str()) == Some("WorkMami")
                    && e.get("base_url").and_then(|v| v.as_str()) == Some(url.as_str())
                    && e.get("ak").and_then(|v| v.as_str()) == Some(ps.api_key.as_str())
            })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回环验证：拷贝本机真实 TRAE 数据库 → 同步 → 校验状态。无本机数据时跳过。
    #[test]
    fn sync_roundtrip_on_local_db() {
        let Some(dir) = storage_dir() else { return };
        let src = db_path(&dir);
        if !src.exists() {
            return;
        }
        let tmp = std::env::temp_dir().join("wm-trae-sync-test.db");
        std::fs::copy(&src, &tmp).unwrap();

        let mut ps = ProxySettings::default();
        ps.api_key = "wm-test-key".into();
        ps.pools = vec![crate::state::ModelPool {
            id: "文员".into(),
            name: "文员".into(),
            rate: 1.0,
            ..Default::default()
        }];

        let n = run_sync(&tmp, &ps).expect("sync 应成功");
        assert!(n > 0, "应至少写入 1 条");
        assert!(synced_at(&tmp, &ps), "同步后状态应为已配置");

        // 幂等：重复同步不写盘
        let n2 = run_sync(&tmp, &ps).expect("重复同步应成功");
        assert_eq!(n2, 0, "重复同步应跳过写盘");
        let _ = std::fs::remove_file(&tmp);
    }
}
