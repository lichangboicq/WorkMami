//! WorkMami 后端库入口：模块装配 + Tauri Builder。
#![allow(
    dead_code,
    reason = "公共 API / 预留扩展点在本地运行期未被引用是正常现象，Rust 默认对 pub 符号仍会 dead_code lint"
)]

mod accounts;
mod api;
mod browser;
mod commands;
#[cfg(debug_assertions)]
mod dev_bridge;
mod data;
mod error;
mod model_display;
mod oauth;
mod platform;
mod proxy;
mod scheduler;
mod state;
mod sync_targets;
mod usage;
mod vault;
mod wbauth;

use std::sync::Arc;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // 单实例：二次启动（如再次双击桌面图标）时呼出已有主窗口，不重复启动第二个进程
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }));
    builder = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ));

    // 主窗口点 X 不退出：隐藏至托盘（托盘菜单“退出”才是真正退出）。
    // OAuth 登录已改为外部独立浏览器 profile（无 Tauri 登录窗），无需窗口事件清理。
    builder = builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if window.label() == "main" {
                api.prevent_close();
                let _ = window.hide();
            }
        }
    });

    builder = builder.setup(|app| {
        platform::init_paths();
        let app_state = Arc::new(AppState::load()?);
        app.manage(app_state.clone());
        // 注入 AppHandle：代理转发层（非 command 上下文）发系统通知需要
        let _ = app_state.app_handle.set(app.handle().clone());

        // dev bridge：让 Trae 内置浏览器等普通客户端也能调用 invoke
        #[cfg(debug_assertions)]
        dev_bridge::start(app_state.clone());

        // 一次性迁移：旧钥匙串 token → 本地加密 vault（迁移后 keyring 条目删除）
        {
            let uids: Vec<String> = app_state.accounts.all().iter().map(|a| a.uid.clone()).collect();
            if !uids.is_empty() {
                vault::migrate_from_keyring("com.workmami.accounts", &uids);
            }
        }
    
        // 账号统一通过"网页授权"添加（扫描无法取得可用 token，已退役）。
        // 登录在**外部浏览器的独立 profile**（browser-profiles/pending-<session>）中完成，
        // 多账号会话天然隔离；登录成功后目录别名到 uid（见 oauth::begin / browser::bind_profile）。
    
        // 启动自定义模型（若配置为启用）
        if app_state.proxy_settings().enabled {
            let st = app_state.clone();
            tauri::async_runtime::spawn(async move {
                proxy::start(st).await;
            });
        }
    
        // 启动调度器（传 AppHandle 用于旅行自动领取通知）
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            match scheduler::start(handle, app_state.clone()).await {
                Ok(sched) => {
                    // 持有 scheduler 防止被 drop
                    use std::sync::OnceLock;
                    static SCHED: OnceLock<tokio_cron_scheduler::JobScheduler> = OnceLock::new();
                    let _ = SCHED.set(sched);
                }
                Err(e) => tracing::error!("调度器启动失败: {e}"),
            }
        });
    
        // 托盘图标：左键点击显示主界面；右键菜单含“显示主界面 / 退出”
        {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            let show_i = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
            let icon = app.default_window_icon().cloned().unwrap_or_else(|| {
                tauri::image::Image::from_bytes(include_bytes!("../icons/icon.ico"))
                    .expect("加载托盘图标失败")
            });
            let _tray = TrayIconBuilder::with_id("workmami-tray")
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
        }

        Ok(())
    });

    builder = builder.invoke_handler(tauri::generate_handler![
        commands::app_info,
        commands::get_settings,
        commands::save_settings,
        commands::proxy_status,
        commands::list_accounts,
        commands::credential_status,
        commands::set_account_enabled,
        commands::set_account_tags,
        commands::delete_account,
        commands::refresh_quota,
        commands::credit_ledger,
        commands::list_models,
        commands::sync_all_ides,
        commands::ide_sync_status,
        commands::oauth_begin,
        commands::oauth_poll,
        commands::checkin_status,
        commands::checkin_all,
        commands::checkin_one,
        commands::travel_overview,
        commands::travel_depart,
        commands::travel_claim,
        commands::travel_records,
        commands::open_growth_center,
        commands::bind_growth_center,
        commands::growth_bound_all,
        commands::data_list,
        commands::data_read,
        commands::data_delete,
        commands::data_export,
        commands::data_backup,
        commands::data_migrate,
        commands::data_uids,
        commands::dashboard_summary,
        commands::dashboard_trend,
        commands::dashboard_top,
        commands::dashboard_heatmap,
        commands::dashboard_balances,
        commands::dashboard_import_app,
        commands::dashboard_requests,
        commands::dashboard_account_billing,
    ]);

    builder.run(tauri::generate_context!()).expect("运行 WorkMami 失败");
}
