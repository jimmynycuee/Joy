use std::ffi::OsString;

pub fn starts_minimized(args: impl IntoIterator<Item = OsString>) -> bool {
    args.into_iter().any(|arg| arg == "--minimized")
}

pub fn should_show_main_window(args: impl IntoIterator<Item = OsString>) -> bool {
    !starts_minimized(args)
}

pub fn updater_is_configured(pubkey: &str, endpoints: &[&str]) -> bool {
    !pubkey.trim().is_empty() && endpoints.iter().any(|endpoint| !endpoint.trim().is_empty())
}

pub fn autostart_checked_state(was_enabled: bool, action_succeeded: bool) -> bool {
    if action_succeeded {
        !was_enabled
    } else {
        was_enabled
    }
}

pub fn completion_notification_title(previous: Option<&str>, current: &str) -> Option<&'static str> {
    let previous = previous?;
    if previous == current
        || !matches!(previous, "queued" | "running" | "awaiting_approval" | "review_ready")
    {
        return None;
    }

    match current {
        "done" => Some("Joy task finished"),
        "failed" | "review_ready" | "cancelled" => Some("Joy task needs attention"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        autostart_checked_state, completion_notification_title, should_show_main_window,
        starts_minimized, updater_is_configured,
    };
    use std::ffi::OsString;

    #[test]
    fn login_launch_argument_starts_the_app_hidden() {
        let args = [OsString::from("joy"), OsString::from("--minimized")];
        assert!(starts_minimized(args));
    }

    #[test]
    fn ordinary_launch_keeps_the_main_window_visible() {
        let args = [OsString::from("joy")];
        assert!(!starts_minimized(args.clone()));
        assert!(should_show_main_window(args));
    }

    #[test]
    fn minimized_login_launch_does_not_show_the_main_window() {
        let args = [OsString::from("joy"), OsString::from("--minimized")];
        assert!(!should_show_main_window(args));
    }

    #[test]
    fn failed_autostart_toggle_restores_the_previous_checked_state() {
        assert!(!autostart_checked_state(false, false));
        assert!(autostart_checked_state(true, false));
        assert!(autostart_checked_state(false, true));
        assert!(!autostart_checked_state(true, true));
    }

    #[test]
    fn updater_requires_a_public_key_and_at_least_one_endpoint() {
        assert!(updater_is_configured("public-key", &["https://updates.example.test"]));
        assert!(!updater_is_configured("", &["https://updates.example.test"]));
        assert!(!updater_is_configured("public-key", &[" "]));
    }

    #[test]
    fn notification_requires_a_task_to_enter_an_alertable_state() {
        assert_eq!(
            completion_notification_title(Some("running"), "done"),
            Some("Joy task finished")
        );
        assert_eq!(
            completion_notification_title(Some("queued"), "failed"),
            Some("Joy task needs attention")
        );
        assert_eq!(
            completion_notification_title(Some("running"), "review_ready"),
            Some("Joy task needs attention")
        );
        assert_eq!(
            completion_notification_title(Some("awaiting_approval"), "cancelled"),
            Some("Joy task needs attention")
        );
        assert_eq!(
            completion_notification_title(Some("review_ready"), "done"),
            Some("Joy task finished")
        );
        assert_eq!(completion_notification_title(Some("review_ready"), "review_ready"), None);
        assert_eq!(completion_notification_title(None, "done"), None);
        assert_eq!(completion_notification_title(Some("running"), "running"), None);
        assert_eq!(completion_notification_title(Some("done"), "done"), None);
        assert_eq!(completion_notification_title(Some("done"), "failed"), None);
    }
}
