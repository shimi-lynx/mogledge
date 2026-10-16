//! One-shot owned-window synthetic modifier probe; no profile or ordinary-key log.
#[cfg(windows)]
fn main() {
    use ::windows::{
        core::w,
        Win32::UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
                KEYEVENTF_KEYUP, VK_CONTROL, VK_LCONTROL, VK_LSHIFT, VK_LWIN, VK_MENU, VK_RWIN,
                VK_SHIFT,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, GetForegroundWindow, SetForegroundWindow,
                ShowWindow, SW_SHOW, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
            },
        },
    };
    use mogledge_backend_tests::resident::windows;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };
    let count = Arc::new(AtomicUsize::new(0));
    let called = count.clone();
    let monitor = windows::start(Arc::new(move || {
        called.fetch_add(1, Ordering::Relaxed);
    }))
    .expect("probe receiver start");
    unsafe {
        let target = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            w!("Resident modifier probe"),
            WS_OVERLAPPEDWINDOW,
            30,
            30,
            320,
            160,
            None,
            None,
            None,
            None,
        )
        .expect("probe window");
        let _ = ShowWindow(target, SW_SHOW);
        let _ = SetForegroundWindow(target);
        let owned_foreground = GetForegroundWindow() == target;
        let neutral = [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN]
            .into_iter()
            .all(|key| GetAsyncKeyState(i32::from(key.0)) >= 0);
        let mut sent = 0;
        if owned_foreground && neutral {
            let inputs: Vec<_> = [VK_LSHIFT, VK_LCONTROL, VK_LSHIFT]
                .into_iter()
                .flat_map(|key| {
                    [false, true].into_iter().map(move |up| INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: key,
                                dwFlags: if up {
                                    KEYEVENTF_KEYUP
                                } else {
                                    Default::default()
                                },
                                ..Default::default()
                            },
                        },
                    })
                })
                .collect();
            // A single atomic batch targets only our verified foreground window.
            sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(Duration::from_millis(500));
        }
        let _ = DestroyWindow(target);
        drop(monitor);
        println!(
            "{}",
            serde_json::json!({"probe":"owned-synthetic-modifiers-only","ownedForeground":owned_foreground,"modifiersReleasedBeforeProbe":neutral,"eventsSent":sent,"callbacks":count.load(Ordering::Relaxed),"physicalInputVerified":false})
        );
    }
}
#[cfg(not(windows))]
fn main() {
    eprintln!("This one-shot modifier probe requires Windows.");
    std::process::exit(1);
}
