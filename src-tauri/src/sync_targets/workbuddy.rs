use std::path::PathBuf;

use serde_json::Value;

use crate::state::ProxySettings;

use super::{IdeSyncTarget, ManualField, ManualGuideJson, R};

pub struct WorkBuddyTarget;

impl IdeSyncTarget for WorkBuddyTarget {
    fn id(&self) -> &'static str {
        "workbuddy"
    }

    fn label(&self) -> &'static str {
        "WorkBuddy"
    }

    fn detect(&self) -> Option<PathBuf> {
        let home = crate::platform::workbuddy_paths().home.clone();
        if home.exists() {
            Some(home)
        } else {
            None
        }
    }

    fn sync(&self, ps: &ProxySettings, _models: &[Value]) -> R<usize> {
        tracing::info!("WorkBuddy sync: detected={}", self.detect().is_some());
        let display_host = if ps.host == "0.0.0.0" { "127.0.0.1" } else { ps.host.as_str() };
        let url = format!("http://{display_host}:{}/v1/chat/completions", ps.port);

        // 同步策略（已拍板）：只把模型池虚拟条目导入 WorkBuddy，
        // 真实模型不再原样写入 models.json，客户端只见池名、不见真实模型名。
        let ours: Vec<Value> = crate::proxy::pools::pool_entries(ps, &url, &ps.api_key);

        let path = crate::platform::workbuddy_paths().home.join("models.json");
        let existing: Vec<Value> = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        // 只清理自己 managedBy 标记的条目（含历史遗留的真实模型托管条目，一并清出）
        let mut kept: Vec<Value> = existing
            .iter()
            .filter(|e| {
                e.get("managedBy").and_then(|v| v.as_str()) != Some("WorkMami")
            })
            .cloned()
            .collect();
        let removed = existing.len() - kept.len();

        // 无池可写且无遗留可清理 → 无需写盘
        if ours.is_empty() && removed == 0 {
            return Ok(0);
        }

        let base = kept.len();
        kept.extend(ours);

        let bytes = match serde_json::to_vec_pretty(&kept) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("WorkBuddy sync: 序列化 models.json 失败: {e}");
                return Err(e.into());
            }
        };
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let tmp = path.with_extension("json.wm-tmp");
        if let Err(e) = std::fs::write(&tmp, &bytes) {
            tracing::warn!("WorkBuddy sync: 写入临时文件失败: {e}");
            return Err(e.into());
        }
        if let Err(e) = std::fs::rename(&tmp, &path) {
            tracing::warn!("WorkBuddy sync: 原子替换 models.json 失败: {e}");
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }

        tracing::info!("WorkBuddy sync: 写入 {} 个池条目，清理 {} 个托管条目，保留原有 {}", kept.len() - base, removed, base);
        Ok(kept.len() - base)
    }

    fn is_synced(&self, ps: &ProxySettings) -> bool {
        let path = crate::platform::workbuddy_paths().home.join("models.json");
        let Some(arr) = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.as_array().cloned())
        else {
            return false;
        };
        let display_host = if ps.host == "0.0.0.0" { "127.0.0.1" } else { ps.host.as_str() };
        let url = format!("http://{display_host}:{}/v1/chat/completions", ps.port);
        // 与 sync() 写入的条目逐字段比对：存在同配置的托管条目即视为已配置。
        arr.iter().any(|e| {
            e.get("managedBy").and_then(|v| v.as_str()) == Some("WorkMami")
                && e.get("url").and_then(|v| v.as_str()) == Some(url.as_str())
                && e.get("apiKey").and_then(|v| v.as_str()) == Some(ps.api_key.as_str())
        })
    }

    fn manual_guide(&self) -> Option<ManualGuideJson> {
        Some(ManualGuideJson {
            title: "在 WorkBuddy 中手动添加 WorkMami 供应商".into(),
            subtitle: "WorkBuddy 未检测到 .workbuddy 目录，或自动同步失败时可按以下步骤手动添加".into(),
            fields: vec![
                ManualField {
                    label: "供应商名称".into(),
                    value: "WorkMami".into(),
                    copy: true,
                },
                ManualField {
                    label: "接口地址".into(),
                    value: "http://127.0.0.1:8765/v1/chat/completions".into(),
                    copy: true,
                },
                ManualField {
                    label: "API Key".into(),
                    value: "（在 WorkMami 设置 → 自定义模型里配置后复制）".into(),
                    copy: false,
                },
                ManualField {
                    label: "模型名称（示例）".into(),
                    value: "wb-balanced".into(),
                    copy: true,
                },
            ],
            footer: "接口地址中的 8765 请替换为你实际配置的自定义模型端口；模型列表以 http://127.0.0.1:<port>/v1/models 为准".into(),
        })
    }
}

