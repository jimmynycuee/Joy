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
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

mod startup;
use startup::{completion_notification_title, starts_minimized};

const TASKS_URL: &str = "http://127.0.0.1:4317/api/tasks";
const POLL_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Default)]
struct DesktopPreferences {
    task_notifications_enabled: AtomicBool,
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
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.manage(DesktopPreferences {
                task_notifications_enabled: AtomicBool::new(true),
            });
            build_tray(app)?;
            start_task_notifications(app.handle().clone());
            if starts_minimized(std::env::args_os()) {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide()?;
                }
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
        .run(tauri::generate_context!())
        .expect("failed to run Joy desktop application");
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
        app.autolaunch().is_enabled().unwrap_or(false),
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
            "launch-at-login" => {
                let autolaunch = app.autolaunch();
                let was_enabled = autolaunch.is_enabled().unwrap_or(false);
                let result = if was_enabled {
                    autolaunch.disable()
                } else {
                    autolaunch.enable()
                };
                match result {
                    Ok(()) => {
                        if let Err(error) = launch_at_login_item.set_checked(!was_enabled) {
                            eprintln!("Could not refresh launch-at-login menu state: {error}");
                        }
                    }
                    Err(error) => eprintln!("Could not update launch-at-login setting: {error}"),
                }
            }
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
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    match check_for_updates(&handle).await {
                        Ok(true) => {
                            send_notification(&handle, "Joy updated", "Joy is restarting now.");
                            handle.restart();
                        }
                        Ok(false) => send_notification(&handle, "Joy is up to date", "No update is available."),
                        Err(_) => send_notification(
                            &handle,
                            "Joy update check unavailable",
                            "Configure the owner-provided HTTPS endpoint and public key to enable updates.",
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

async fn check_for_updates(app: &tauri::AppHandle) -> tauri_plugin_updater::Result<bool> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_, _| {}, || {}).await?;
        Ok(true)
    } else {
        Ok(false)
    }
}
