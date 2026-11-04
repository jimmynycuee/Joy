use std::ffi::OsString;

pub fn starts_minimized(args: impl IntoIterator<Item = OsString>) -> bool {
    args.into_iter().any(|arg| arg == "--minimized")
}

pub fn completion_notification_title(previous: Option<&str>, current: &str) -> Option<&'static str> {
    let previous = previous?;
    if !matches!(previous, "queued" | "running" | "awaiting_approval" | "review_ready") {
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
    use super::{completion_notification_title, starts_minimized};
    use std::ffi::OsString;

    #[test]
    fn login_launch_argument_starts_the_app_hidden() {
        let args = [OsString::from("joy"), OsString::from("--minimized")];
        assert!(starts_minimized(args));
    }

    #[test]
    fn ordinary_launch_keeps_the_main_window_visible() {
        let args = [OsString::from("joy")];
        assert!(!starts_minimized(args));
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
        assert_eq!(completion_notification_title(None, "done"), None);
        assert_eq!(completion_notification_title(Some("running"), "running"), None);
        assert_eq!(completion_notification_title(Some("done"), "failed"), None);
    }
}
