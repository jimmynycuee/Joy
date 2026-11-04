use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use reqwest::Client;
use serde::Deserialize;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

mod startup;
use startup::{
    autostart_checked_state, completion_notification_title, should_show_main_window,
    updater_is_configured,
};

const TASKS_URL: &str = "http://127.0.0.1:4317/api/tasks";
const POLL_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Default)]
struct DesktopPreferences {
    launch_at_login_enabled: AtomicBool,
    task_notifications_enabled: AtomicBool,
    update_check_in_progress: AtomicBool,
}

#[derive(Deserialize)]
struct TaskList {
    tasks: Vec<TaskSnapshot>,
}

#[derive(Deserialize)]
struct TaskSnapshot {
    id: String,
    status: String,
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let launch_at_login_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            app.manage(DesktopPreferences {
                launch_at_login_enabled: AtomicBool::new(launch_at_login_enabled),
                task_notifications_enabled: AtomicBool::new(true),
                update_check_in_progress: AtomicBool::new(false),
            });
            build_tray(app)?;
            start_task_notifications(app.handle().clone());
            if should_show_main_window(std::env::args_os()) {
                show_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("Could not hide Joy window: {error}");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Joy desktop application");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            show_main_window(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Joy", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide Joy", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let launch_at_login = CheckMenuItem::with_id(
        app,
        "launch-at-login",
        "Launch at login",
        true,
        app.state::<DesktopPreferences>()
            .launch_at_login_enabled
            .load(Ordering::Relaxed),
        None::<&str>,
    )?;
    let task_notifications = CheckMenuItem::with_id(
        app,
        "task-notifications",
        "Task notifications",
        true,
        true,
        None::<&str>,
    )?;
    let check_updates = MenuItem::with_id(app, "check-updates", "Check for updates", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Joy", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &hide,
            &separator,
            &launch_at_login,
            &task_notifications,
            &check_updates,
            &quit,
        ],
    )?;
    let launch_at_login_item = launch_at_login.clone();
    let task_notifications_item = task_notifications.clone();

    TrayIconBuilder::new()
        .tooltip("Joy")
        .icon(
            app.default_window_icon()
                .expect("Joy application icon must be configured")
                .clone(),
        )
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.hide() {
                        eprintln!("Could not hide Joy window: {error}");
                    }
                }
            }
            "launch-at-login" => toggle_launch_at_login(app, &launch_at_login_item),
            "task-notifications" => {
                let preferences = app.state::<DesktopPreferences>();
                let enabled = !preferences
                    .task_notifications_enabled
                    .load(Ordering::Relaxed);
                preferences
                    .task_notifications_enabled
                    .store(enabled, Ordering::Relaxed);
                if let Err(error) = task_notifications_item.set_checked(enabled) {
                    eprintln!("Could not refresh task-notification menu state: {error}");
                }
            }
            "check-updates" => {
                let in_progress = app
                    .state::<DesktopPreferences>()
                    .update_check_in_progress
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed);
                if in_progress.is_err() {
                    send_notification(
                        app,
                        "Joy update already running",
                        "Wait for the current update check to finish.",
                    );
                    return;
                }
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let result = check_for_updates(&handle).await;
                    handle
                        .state::<DesktopPreferences>()
                        .update_check_in_progress
                        .store(false, Ordering::Release);
                    match result {
                        Ok(true) => {
                            send_notification(&handle, "Joy updated", "Joy is restarting now.");
                            handle.restart();
                        }
                        Ok(false) => send_notification(
                            &handle,
                            "Joy is up to date",
                            "No update is available.",
                        ),
                        Err(UpdateCheckError::NotConfigured) => send_notification(
                            &handle,
                            "Joy updater not configured",
                            "The owner-provided HTTPS endpoint and public key are required.",
                        ),
                        Err(UpdateCheckError::Failed) => send_notification(
                            &handle,
                            "Joy update check failed",
                            "Check the network and updater configuration, then try again.",
                        ),
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn toggle_launch_at_login(app: &tauri::AppHandle, item: &CheckMenuItem) {
    let preferences = app.state::<DesktopPreferences>();
    let known_enabled = preferences
        .launch_at_login_enabled
        .load(Ordering::Relaxed);
    let was_enabled = match app.autolaunch().is_enabled() {
        Ok(enabled) => enabled,
        Err(error) => {
            eprintln!("Could not read launch-at-login setting: {error}");
            if let Err(error) = item.set_checked(known_enabled) {
                eprintln!("Could not restore launch-at-login menu state: {error}");
            }
            return;
        }
    };
    let result = if was_enabled {
        app.autolaunch().disable()
    } else {
        app.autolaunch().enable()
    };
    match result {
        Ok(()) => {
            let enabled = autostart_checked_state(was_enabled, true);
            preferences
                .launch_at_login_enabled
                .store(enabled, Ordering::Relaxed);
            if let Err(error) = item.set_checked(enabled) {
                eprintln!("Could not refresh launch-at-login menu state: {error}");
            }
        }
        Err(error) => {
            let restored = autostart_checked_state(was_enabled, false);
            preferences
                .launch_at_login_enabled
                .store(restored, Ordering::Relaxed);
            eprintln!("Could not update launch-at-login setting: {error}");
            if let Err(error) = item.set_checked(restored) {
                eprintln!("Could not restore launch-at-login menu state: {error}");
            }
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.show() {
            eprintln!("Could not show Joy window: {error}");
        }
        if let Err(error) = window.set_focus() {
            eprintln!("Could not focus Joy window: {error}");
        }
    }
}

fn start_task_notifications(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = match Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(2))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                eprintln!("Could not start Joy task notifications: {error}");
                return;
            }
        };
        let mut statuses = HashMap::new();
        let mut initialized = false;

        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let response = match client.get(TASKS_URL).send().await {
                Ok(response) => response,
                Err(_) => continue,
            };
            let response = match response.error_for_status() {
                Ok(response) => response,
                Err(_) => continue,
            };
            let task_list = match response.json::<TaskList>().await {
                Ok(task_list) => task_list,
                Err(_) => continue,
            };

            if !initialized {
                statuses.extend(
                    task_list
                        .tasks
                        .into_iter()
                        .map(|task| (task.id, task.status)),
                );
                initialized = true;
                continue;
            }

            let mut observed = HashSet::new();
            for task in task_list.tasks {
                observed.insert(task.id.clone());
                let previous = statuses.insert(task.id, task.status.clone());
                let Some(title) = completion_notification_title(previous.as_deref(), &task.status)
                else {
                    continue;
                };
                if app
                    .state::<DesktopPreferences>()
                    .task_notifications_enabled
                    .load(Ordering::Relaxed)
                    && window_is_hidden(&app)
                {
                    send_notification(
                        &app,
                        title,
                        "Open Joy to review the latest task result.",
                    );
                }
            }
            statuses.retain(|task_id, _| observed.contains(task_id));
        }
    });
}

fn window_is_hidden(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .map(|visible| !visible)
        .unwrap_or(true)
}

fn send_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    if let Err(error) = app.notification().builder().title(title).body(body).show() {
        eprintln!("Could not send Joy desktop notification: {error}");
    }
}

#[derive(Debug)]
enum UpdateCheckError {
    NotConfigured,
    Failed,
}

fn updater_configuration_is_present(app: &tauri::AppHandle) -> bool {
    let Some(updater) = app.config().plugins.0.get("updater") else {
        return false;
    };
    let pubkey = updater
        .get("pubkey")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let Some(endpoints) = updater.get("endpoints").and_then(|value| value.as_array()) else {
        return false;
    };
    let endpoints = endpoints
        .iter()
        .filter_map(|endpoint| endpoint.as_str())
        .collect::<Vec<_>>();
    updater_is_configured(pubkey, &endpoints)
}

async fn check_for_updates(app: &tauri::AppHandle) -> Result<bool, UpdateCheckError> {
    if !updater_configuration_is_present(app) {
        return Err(UpdateCheckError::NotConfigured);
    }
    let update = app
        .updater()
        .map_err(|_| UpdateCheckError::Failed)?
        .check()
        .await
        .map_err(|_| UpdateCheckError::Failed)?;
    if let Some(update) = update {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|_| UpdateCheckError::Failed)?;
        Ok(true)
    } else {
        Ok(false)
    }
}
