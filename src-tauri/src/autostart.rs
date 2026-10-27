//! 开机自启动管理（仅 Windows 生效，其它平台返回安全默认值）。
//!
//! 目标：**全局只保留一个机器级（HKLM）启动项**。
//! 历史版本曾在三个位置写入启动入口，重复存在时会导致开机拉起两个进程：
//!   1. HKCU `Software\Microsoft\Windows\CurrentVersion\Run`（tauri-plugin-autostart / 旧 NSIS）
//!   2. HKCU `...\Explorer\StartupApproved\Run`（对应的状态标记）
//!   3. 用户 Startup 文件夹 `%APPDATA%\...\Programs\Startup\WorkMami.lnk`
//!
//! 因此清理动作由两类入口承担：安装程序（NSIS / MSI）安装时清理，以及
//! 应用内关闭自启动时清理；"开启"则在写入 HKLM 前先清一遍历史入口。
//!
//! 注意：写 HKLM 需要管理员权限。本应用安装在 Program Files（perMachine），
//! 内置 Administrator 账户/提权场景下可直接写入；无权限时返回错误给前端提示。

use crate::error::WmError;

type R<T> = Result<T, WmError>;

/// 启动项值名，与 tauri.conf.json 的 productName / 安装程序的 ${PRODUCTNAME} 保持一致。
const VALUE_NAME: &str = "WorkMami";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const SA_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
/// StartupApproved 的"已启用"标记（Task Manager 启动列表按此显示状态）。
const SA_ENABLED: [u8; 12] = [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// ---------- Windows 实现 ----------

#[cfg(windows)]
mod imp {
    use super::*;
    use std::fs;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    /// 用户 Startup 文件夹（%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup）
    fn user_startup_dir() -> Option<std::path::PathBuf> {
        dirs::data_dir().map(|d| d.join(r"Microsoft\Windows\Start Menu\Programs\Startup"))
    }

    pub fn user_startup_lnk() -> Option<std::path::PathBuf> {
        user_startup_dir().map(|d| d.join(format!("{VALUE_NAME}.lnk")))
    }

    /// 清理历史遗留的"每个用户"启动入口：
    /// HKCU Run 值、HKCU StartupApproved 值、Startup 文件夹快捷方式。
    /// 返回实际清理掉的位置列表（用于日志）。
    pub fn sweep_legacy() -> Vec<String> {
        let mut removed = Vec::new();

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for key_path in [RUN_KEY, SA_KEY] {
            if let Ok(key) = hkcu.open_subkey_with_flags(key_path, KEY_SET_VALUE) {
                match key.delete_value(VALUE_NAME) {
                    Ok(()) => removed.push(format!("HKCU\\{key_path}\\{VALUE_NAME}")),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => tracing::warn!("清理 HKCU 启动项失败({key_path}): {e}"),
                }
            }
        }

        if let Some(lnk) = user_startup_lnk() {
            if lnk.exists() {
                match fs::remove_file(&lnk) {
                    Ok(()) => removed.push(lnk.to_string_lossy().to_string()),
                    Err(e) => tracing::warn!("清理 Startup 文件夹快捷方式失败: {e}"),
                }
            }
        }

        if !removed.is_empty() {
            tracing::info!("已清理历史自启动入口: {:?}", removed);
        }
        removed
    }

    /// HKLM Run 启动项是否存在。
    pub fn hklm_enabled() -> bool {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        hklm.open_subkey_with_flags(RUN_KEY, KEY_READ)
            .and_then(|k| k.get_value::<String, _>(VALUE_NAME))
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    }

    /// 写入 HKLM 启动项（需要管理员权限）。
    pub fn hklm_enable() -> Result<(), String> {
        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(e) => return Err(format!("无法定位主程序: {e}")),
        };
        let command = format!("\"{}\" --hidden", exe.to_string_lossy());

        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let run = hklm
            .open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
            .or_else(|e| Err(format!("无权限写入 HKLM 启动项（需要以管理员身份运行）: {e}")))?;
        if let Err(e) = run.set_value(VALUE_NAME, &command) {
            return Err(format!("写入 HKLM Run 失败: {e}"));
        }

        // StartupApproved 启用标记写失败不致命（仅影响任务管理器里的状态展示）
        if let Ok(sa) = hklm.open_subkey_with_flags(SA_KEY, KEY_SET_VALUE) {
            let rv = winreg::RegValue {
                bytes: SA_ENABLED.to_vec(),
                vtype: winreg::enums::RegType::REG_BINARY,
            };
            let _ = sa.set_raw_value(VALUE_NAME, &rv);
        }
        Ok(())
    }

    /// 删除 HKLM 启动项及其状态标记。
    pub fn hklm_disable() {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        for key_path in [RUN_KEY, SA_KEY] {
            if let Ok(key) = hklm.open_subkey_with_flags(key_path, KEY_SET_VALUE) {
                match key.delete_value(VALUE_NAME) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => tracing::warn!("删除 HKLM 启动项失败({key_path}): {e}"),
                }
            }
        }
    }
}

// ---------- 非 Windows 占位 ----------

#[cfg(not(windows))]
mod imp {
    pub fn sweep_legacy() -> Vec<String> {
        Vec::new()
    }
    pub fn hklm_enabled() -> bool {
        false
    }
    pub fn hklm_enable() -> Result<(), String> {
        Err("当前平台不支持开机自启动".into())
    }
    pub fn hklm_disable() {}
}

// ---------- 对外（Tauri command） ----------

/// 查询自启动状态：以唯一的 HKLM 机器级启动项为准。
#[tauri::command]
pub fn autostart_status() -> bool {
    imp::hklm_enabled()
}

/// 开启自启动：先清理历史 HKCU / Startup 文件夹入口，再写 HKLM（唯一入口）。
#[tauri::command]
pub fn autostart_enable() -> R<()> {
    imp::sweep_legacy();
    imp::hklm_enable()
        .map_err(|e| WmError::Config(format!("开启开机自启动失败: {e}")))
}

/// 关闭自启动：清理全部三个位置的启动入口（HKCU、HKLM、Startup 文件夹）。
#[tauri::command]
pub fn autostart_disable() -> R<()> {
    imp::sweep_legacy();
    imp::hklm_disable();
    Ok(())
}
