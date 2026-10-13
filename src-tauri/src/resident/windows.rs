//! Background modifier taps through non-intercepting Windows Raw Input.
//!
//! The receiver owns its HWND, registration and message thread. No ordinary-key
//! names/identities, text conversion, input suppression or idle polling. Explicit
//! bounded QA can report only target modifier labels and processing stages.

use super::sequence::{Key, KeyEvent, Sequence};
use std::{
    io::Write,
    mem::size_of,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, OnceLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows::{
    core::w,
    Win32::{
        Foundation::{
            CloseHandle, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WAIT_OBJECT_0, WPARAM,
        },
        System::{
            LibraryLoader::GetModuleHandleW,
            Threading::{
                CreateEventW, GetCurrentProcessId, GetCurrentThreadId, SetEvent,
                WaitForSingleObject, INFINITE,
            },
        },
        UI::{
            Input::{
                GetRawInputData, GetRegisteredRawInputDevices,
                KeyboardAndMouse::{
                    GetAsyncKeyState, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN,
                    VK_MENU, VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT,
                },
                RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER,
                RAWKEYBOARD, RIDEV_DEVNOTIFY, RIDEV_INPUTSINK, RIDEV_REMOVE, RID_INPUT,
                RIM_TYPEKEYBOARD,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClassNameW,
                GetForegroundWindow, GetWindowLongPtrW, GetWindowThreadProcessId,
                MsgWaitForMultipleObjectsEx, PeekMessageW, RegisterClassW, SetWindowLongPtrW,
                UnregisterClassW, GWLP_USERDATA, HWND_MESSAGE, MSG, MWMO_INPUTAVAILABLE, PM_REMOVE,
                QS_ALLINPUT, RI_KEY_BREAK, RI_KEY_E0, WINDOW_EX_STYLE, WINDOW_STYLE, WM_INPUT,
                WM_INPUT_DEVICE_CHANGE, WM_QUIT, WNDCLASSW,
            },
        },
    },
};

const UNAVAILABLE: &str = "ResidentInputUnavailable";
const CONFLICT: &str = "ResidentInputConflict";
const CLASS_NAME: windows::core::PCWSTR = w!("MyKnowledgeResidentInput");
const KEYBOARD_USAGE_PAGE: u16 = 1;
const KEYBOARD_USAGE: u16 = 6;

// An event can be signalled across threads. Only this owner closes it, after
// joining the receiver. Integer storage keeps OS handle ownership explicit
// without declaring arbitrary HWND/HANDLE pointers Send or Sync.
struct StopEvent(isize);
impl StopEvent {
    fn handle(&self) -> HANDLE {
        HANDLE(self.0 as *mut _)
    }
}
impl Drop for StopEvent {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle());
        }
    }
}

pub struct Monitor {
    stop: StopEvent,
    thread: Option<JoinHandle<()>>,
    receiver: isize,
}
impl Monitor {
    pub fn is_running(&self) -> bool {
        self.thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
            && unsafe {
                keyboard_receiver().is_ok_and(|hwnd| hwnd == Some(HWND(self.receiver as *mut _)))
            }
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        // Wake an idle receiver through its event, not a posted message which
        // can fail when a keyboard-flooded message queue is full.
        unsafe {
            let _ = SetEvent(self.stop.handle());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn permitted() -> bool {
    true
}

pub fn open_permission_settings() -> Result<(), &'static str> {
    Err("ResidentPermissionNotRequired")
}

pub fn start(callback: Arc<dyn Fn() + Send + Sync>) -> Result<Monitor, &'static str> {
    diagnostic("start", None);
    let stop = StopEvent(
        unsafe { CreateEventW(None, true, false, None) }
            .map_err(|_| UNAVAILABLE)?
            .0 as isize,
    );
    let stop_handle = stop.0;
    let (ready, started) = mpsc::sync_channel(1);
    let thread = thread::Builder::new()
        .name("resident-input".into())
        .spawn(move || receive(stop_handle, callback, ready))
        .map_err(|_| UNAVAILABLE)?;
    let mut monitor = Monitor {
        stop,
        thread: Some(thread),
        receiver: 0,
    };
    match started.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(receiver)) => {
            monitor.receiver = receiver;
            diagnostic("ready", None);
            Ok(monitor)
        }
        Ok(Err(error)) => {
            diagnostic("start-failed", Some(error));
            Err(error)
        }
        Err(_) => {
            diagnostic("start-timeout", Some(UNAVAILABLE));
            Err(UNAVAILABLE)
        }
    }
}

struct ReceiverState {
    sequence: Sequence,
    last_message_tick: Option<u32>,
    event_time: Duration,
    complete: bool,
    blocking_modifiers: u8,
}
impl ReceiverState {
    fn new() -> Self {
        let mut state = Self {
            sequence: Sequence::default(),
            last_message_tick: None,
            event_time: Duration::ZERO,
            complete: false,
            blocking_modifiers: 0,
        };
        state.block_held_modifiers();
        state
    }

    fn block_held_modifiers(&mut self) {
        // Modifiers held before enabling must be released before a gesture.
        // Preserve modifier-down metadata while discarding any partial tap.
        for (virtual_key, key) in [
            (VK_LSHIFT, Key::ShiftLeft),
            (VK_RSHIFT, Key::ShiftRight),
            (VK_LCONTROL, Key::PrimaryLeft),
            (VK_RCONTROL, Key::PrimaryRight),
        ] {
            if unsafe { GetAsyncKeyState(i32::from(virtual_key.0)) } < 0 {
                let now = self.event_time;
                self.sequence.input(KeyEvent::Down(key), now);
            }
        }
        self.sequence.cancel_pending();
        self.blocking_modifiers = 0;
        // Only modifier metadata is queried at stream start/device change.
        // Alt/Win retain separate bits, never the ordinary-key anonymous latch.
        for (virtual_key, bit) in [(VK_LMENU, 1), (VK_RMENU, 2), (VK_LWIN, 4), (VK_RWIN, 8)] {
            if unsafe { GetAsyncKeyState(i32::from(virtual_key.0)) } < 0 {
                self.blocking_modifiers |= bit;
            }
        }
    }

    fn key(&mut self, key: InputKey, down: bool, now: Duration) {
        let before = self.sequence.diagnostic_state();
        match key {
            InputKey::BlockingModifier(bit) => {
                if down {
                    self.blocking_modifiers |= bit;
                } else {
                    self.blocking_modifiers &= !bit;
                }
                self.sequence.cancel_pending();
                self.complete = false;
            }
            InputKey::Gesture(key) => {
                let event = if down {
                    KeyEvent::Down(key)
                } else {
                    KeyEvent::Up(key)
                };
                let complete = self.sequence.input(event, now);
                if self.blocking_modifiers != 0 {
                    // Still update Shift/Ctrl and anonymous ordinary-key held
                    // metadata. Releasing Alt/Win cannot fabricate neutral state.
                    self.sequence.cancel_pending();
                    self.complete = false;
                } else {
                    self.complete |= complete;
                }
            }
        }
        if let Some(modifier) = gesture_modifier(key) {
            gesture_diagnostic("modifier", || {
                let after = self.sequence.diagnostic_state();
                serde_json::json!({"modifier":modifier,"down":down,"elapsedMs":now.as_millis(),
                    "stepBefore":before.step,"stepAfter":after.step,"heldModifiers":after.held_modifiers,
                    "anonymousKeyHeld":after.anonymous_key_held,"blockingModifierHeld":self.blocking_modifiers!=0,"complete":self.complete})
            });
        }
    }

    fn message_time(&mut self, tick: u32) {
        // MSG.time is the posted time. A delayed queue drain must not compress
        // a held chord into the 50ms rollover allowance. Handle DWORD wrap.
        if let Some(previous) = self.last_message_tick {
            self.event_time += Duration::from_millis(u64::from(tick.wrapping_sub(previous)));
        }
        self.last_message_tick = Some(tick);
    }

    fn reset(&mut self) {
        self.sequence.input(KeyEvent::Reset, self.event_time);
        self.complete = false;
        self.block_held_modifiers();
    }
}

struct WindowClass(HINSTANCE);
impl Drop for WindowClass {
    fn drop(&mut self) {
        unsafe {
            let _ = UnregisterClassW(CLASS_NAME, Some(self.0));
        }
    }
}

struct ReceiverWindow {
    hwnd: HWND,
    _class: WindowClass,
    state: Box<ReceiverState>,
    registered: bool,
}
impl ReceiverWindow {
    fn create() -> Result<Self, &'static str> {
        unsafe {
            let instance = HINSTANCE(GetModuleHandleW(None).map_err(|_| UNAVAILABLE)?.0);
            let class = WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: instance,
                lpszClassName: CLASS_NAME,
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                return Err(UNAVAILABLE);
            }
            let class = WindowClass(instance);
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                CLASS_NAME,
                w!(""),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(instance),
                None,
            )
            .map_err(|_| UNAVAILABLE)?;
            let mut receiver = Self {
                hwnd,
                _class: class,
                state: Box::new(ReceiverState::new()),
                registered: false,
            };
            SetWindowLongPtrW(
                hwnd,
                GWLP_USERDATA,
                receiver.state.as_mut() as *mut ReceiverState as isize,
            );
            // Raw Input permits one receiver per process/device class. Do not
            // replace a WebView or another component's existing registration.
            if keyboard_receiver()?.is_some() {
                diagnostic("registration-conflict", Some(CONFLICT));
                return Err(CONFLICT);
            }
            RegisterRawInputDevices(
                &[RAWINPUTDEVICE {
                    usUsagePage: KEYBOARD_USAGE_PAGE,
                    usUsage: KEYBOARD_USAGE,
                    dwFlags: RIDEV_INPUTSINK | RIDEV_DEVNOTIFY,
                    hwndTarget: hwnd,
                }],
                size_of::<RAWINPUTDEVICE>() as u32,
            )
            .map_err(|_| UNAVAILABLE)?;
            receiver.registered = true;
            diagnostic("registered", None);
            gesture_diagnostic("receiver-ready", || {
                let state = receiver.state.sequence.diagnostic_state();
                serde_json::json!({"heldModifiers":state.held_modifiers,"blockingModifierHeld":receiver.state.blocking_modifiers!=0})
            });
            Ok(receiver)
        }
    }
}
impl Drop for ReceiverWindow {
    fn drop(&mut self) {
        diagnostic("receiver-stop", None);
        unsafe {
            // A later registration may belong to another app component. Never
            // remove that component's receiver while disabling this feature.
            if self.registered && keyboard_receiver().is_ok_and(|hwnd| hwnd == Some(self.hwnd)) {
                let _ = RegisterRawInputDevices(
                    &[RAWINPUTDEVICE {
                        usUsagePage: KEYBOARD_USAGE_PAGE,
                        usUsage: KEYBOARD_USAGE,
                        dwFlags: RIDEV_REMOVE,
                        hwndTarget: HWND::default(),
                    }],
                    size_of::<RAWINPUTDEVICE>() as u32,
                );
            }
            SetWindowLongPtrW(self.hwnd, GWLP_USERDATA, 0);
            let _ = DestroyWindow(self.hwnd);
        }
        diagnostic("receiver-stopped", None);
    }
}

// Explicit QA opt-in. Never log input events, titles, document data or paths.
// This API reads this process only; a NULL target is still a registration.
fn diagnostic(event: &str, error: Option<&str>) {
    if std::env::var_os("MY_KNOWLEDGE_RESIDENT_DIAGNOSTICS").as_deref()
        != Some(std::ffi::OsStr::new("1"))
    {
        return;
    }
    unsafe {
        let mut devices = [RAWINPUTDEVICE::default(); 128];
        let mut count = devices.len() as u32;
        let read = GetRegisteredRawInputDevices(
            Some(devices.as_mut_ptr()),
            &mut count,
            size_of::<RAWINPUTDEVICE>() as u32,
        );
        let registrations: Vec<_> = if read != u32::MAX && read as usize <= devices.len() {
            devices[..read as usize].iter().map(|device| {
                let mut pid = 0;
                let mut class = [0_u16; 256];
                let (thread, length) = if device.hwndTarget.is_invalid() { (0, 0) } else {
                    (GetWindowThreadProcessId(device.hwndTarget, Some(&mut pid)), GetClassNameW(device.hwndTarget, &mut class))
                };
                serde_json::json!({"usagePage": device.usUsagePage, "usage": device.usUsage, "flags": device.dwFlags.0,
                    "targetHwnd": if device.hwndTarget.is_invalid() { None } else { Some(device.hwndTarget.0 as usize) },
                    "targetPid": pid, "targetThread": thread, "targetClass": String::from_utf16_lossy(&class[..length.max(0) as usize])})
            }).collect()
        } else {
            Vec::new()
        };
        let record = serde_json::json!({"event": event, "pid": GetCurrentProcessId(), "thread": GetCurrentThreadId(),
            "error": error, "registrationReadSucceeded": read != u32::MAX && read as usize <= devices.len(), "registrations": registrations});
        let _ = writeln!(std::io::stderr().lock(), "resident-diagnostic {record}");
    }
}

// Explicit, bounded gesture investigation. Only Shift/Ctrl labels and state
// metadata are permitted; ordinary keys never reach this diagnostic renderer.
pub(super) fn gesture_diagnostic(
    event: &'static str,
    details: impl FnOnce() -> serde_json::Value,
) -> bool {
    if std::env::var_os("MY_KNOWLEDGE_RESIDENT_GESTURE_DIAGNOSTICS").as_deref()
        != Some(std::ffi::OsStr::new("1"))
    {
        return false;
    }
    static STARTED: OnceLock<Instant> = OnceLock::new();
    static RECORDS: AtomicUsize = AtomicUsize::new(0);
    if STARTED.get_or_init(Instant::now).elapsed() > Duration::from_secs(120)
        || RECORDS.fetch_add(1, Ordering::Relaxed) >= 128
    {
        return false;
    }
    let mut foreground_pid = 0;
    unsafe {
        GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut foreground_pid));
    }
    let record = serde_json::json!({"event":event,"foregroundIsApp":foreground_pid==unsafe {GetCurrentProcessId()},"details":details()});
    writeln!(
        std::io::stderr().lock(),
        "resident-gesture-diagnostic {record}"
    )
    .is_ok()
}

fn gesture_modifier(key: InputKey) -> Option<&'static str> {
    match key {
        InputKey::Gesture(Key::ShiftLeft) => Some("shift-left"),
        InputKey::Gesture(Key::ShiftRight) => Some("shift-right"),
        InputKey::Gesture(Key::PrimaryLeft) => Some("ctrl-left"),
        InputKey::Gesture(Key::PrimaryRight) => Some("ctrl-right"),
        _ => None,
    }
}

fn packet_modifier(virtual_key: u16, make_code: u16, flags: u16) -> Option<&'static str> {
    gesture_modifier(classify(virtual_key, make_code, flags)).or({
        if virtual_key == VK_SHIFT.0 {
            Some("shift-unspecified")
        } else {
            None
        }
    })
}

unsafe fn keyboard_receiver() -> Result<Option<HWND>, &'static str> {
    // This is registration metadata, not captured input. Bound the stack read
    // and fail closed if another component has unusually many registrations.
    let mut devices = [RAWINPUTDEVICE::default(); 128];
    let mut count = devices.len() as u32;
    let read = GetRegisteredRawInputDevices(
        Some(devices.as_mut_ptr()),
        &mut count,
        size_of::<RAWINPUTDEVICE>() as u32,
    );
    if read == u32::MAX || read as usize > devices.len() {
        return Err(UNAVAILABLE);
    }
    Ok(devices[..read as usize]
        .iter()
        .find(|device| {
            device.usUsagePage == KEYBOARD_USAGE_PAGE && device.usUsage == KEYBOARD_USAGE
        })
        .map(|device| device.hwndTarget))
}

fn receive(
    stop: isize,
    callback: Arc<dyn Fn() + Send + Sync>,
    ready: mpsc::SyncSender<Result<isize, &'static str>>,
) {
    let mut receiver = match ReceiverWindow::create() {
        Ok(receiver) => receiver,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    if ready.send(Ok(receiver.hwnd.0 as isize)).is_err() {
        return;
    }
    let stop = HANDLE(stop as *mut _);
    unsafe {
        'messages: loop {
            let wait = MsgWaitForMultipleObjectsEx(
                Some(&[stop]),
                INFINITE,
                QS_ALLINPUT,
                MWMO_INPUTAVAILABLE,
            );
            if wait.0 != WAIT_OBJECT_0.0 + 1 {
                break;
            }
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                if WaitForSingleObject(stop, 0) == WAIT_OBJECT_0 || message.message == WM_QUIT {
                    break 'messages;
                }
                if message.hwnd == receiver.hwnd
                    && matches!(message.message, WM_INPUT | WM_INPUT_DEVICE_CHANGE)
                {
                    receiver.state.message_time(message.time);
                }
                DispatchMessageW(&message);
                if std::mem::take(&mut receiver.state.complete) {
                    // The callback only queues application activation. It must
                    // not synchronously disable/drop this receiver on its thread.
                    gesture_diagnostic("recall-callback", || serde_json::json!({}));
                    callback();
                }
            }
        }
    }
    // Drop unregisters on the same thread that owns the HWND, then destroys it.
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if matches!(message, WM_INPUT | WM_INPUT_DEVICE_CHANGE) {
        let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ReceiverState;
        if let Some(state) = pointer.as_mut() {
            if message == WM_INPUT_DEVICE_CHANGE {
                state.reset();
            } else {
                input(state, lparam);
            }
        }
    }
    // In particular WM_INPUT foreground cleanup needs DefWindowProc. Legacy
    // keyboard delivery and OS hotkeys remain untouched (no NOLEGACY flags).
    DefWindowProcW(hwnd, message, wparam, lparam)
}

unsafe fn input(state: &mut ReceiverState, lparam: LPARAM) {
    let mut raw = RAWINPUT::default();
    let mut capacity = size_of::<RAWINPUT>() as u32;
    let read = GetRawInputData(
        HRAWINPUT(lparam.0 as *mut _),
        RID_INPUT,
        Some(&mut raw as *mut RAWINPUT as *mut _),
        &mut capacity,
        size_of::<RAWINPUTHEADER>() as u32,
    );
    if read == u32::MAX
        || read < (size_of::<RAWINPUTHEADER>() + size_of::<RAWKEYBOARD>()) as u32
        || raw.header.dwType != RIM_TYPEKEYBOARD.0
    {
        state.reset();
        return;
    }
    let keyboard = raw.data.keyboard;
    let key = classify(keyboard.VKey, keyboard.MakeCode, keyboard.Flags);
    if raw.header.hDevice.is_invalid() {
        if let Some(modifier) = packet_modifier(keyboard.VKey, keyboard.MakeCode, keyboard.Flags) {
            gesture_diagnostic(
                "modifier-rejected",
                || serde_json::json!({"modifier":modifier,"down":u32::from(keyboard.Flags)&RI_KEY_BREAK==0,"reason":"missing-device"}),
            );
        }
        state.reset();
        return;
    }
    // KEYBOARD_OVERRUN_MAKE_CODE and unmapped keys cannot form a gesture.
    if keyboard.MakeCode == 0xff || keyboard.VKey >= 0xff {
        state.reset();
        return;
    }
    if gesture_modifier(key).is_none() {
        if let Some(modifier) = packet_modifier(keyboard.VKey, keyboard.MakeCode, keyboard.Flags) {
            gesture_diagnostic(
                "modifier-unmapped",
                || serde_json::json!({"modifier":modifier,"down":u32::from(keyboard.Flags)&RI_KEY_BREAK==0,"makeCode":keyboard.MakeCode,"flags":keyboard.Flags}),
            );
        }
    }
    state.key(
        key,
        u32::from(keyboard.Flags) & RI_KEY_BREAK == 0,
        state.event_time,
    );
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InputKey {
    Gesture(Key),
    BlockingModifier(u8),
}

fn classify(virtual_key: u16, make_code: u16, flags: u16) -> InputKey {
    // Raw Input commonly uses generic SHIFT/CONTROL codes. The two modifier
    // scan-code cases identify sides. Alt/Win have only held metadata; all
    // ordinary values become anonymous Other immediately.
    let blocking_modifier = match virtual_key {
        key if key == VK_LMENU.0 => 1,
        key if key == VK_RMENU.0 => 2,
        key if key == VK_LWIN.0 => 4,
        key if key == VK_RWIN.0 => 8,
        key if key == VK_MENU.0 && u32::from(flags) & RI_KEY_E0 == 0 => 1,
        key if key == VK_MENU.0 => 2,
        _ => 0,
    };
    if blocking_modifier != 0 {
        return InputKey::BlockingModifier(blocking_modifier);
    }
    InputKey::Gesture(match virtual_key {
        key if key == VK_LSHIFT.0 => Key::ShiftLeft,
        key if key == VK_RSHIFT.0 => Key::ShiftRight,
        key if key == VK_LCONTROL.0 => Key::PrimaryLeft,
        key if key == VK_RCONTROL.0 => Key::PrimaryRight,
        key if key == VK_SHIFT.0 && make_code == 0x2a => Key::ShiftLeft,
        key if key == VK_SHIFT.0 && make_code == 0x36 => Key::ShiftRight,
        key if key == VK_CONTROL.0 && u32::from(flags) & RI_KEY_E0 == 0 => Key::PrimaryLeft,
        key if key == VK_CONTROL.0 => Key::PrimaryRight,
        _ => Key::Other,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ExistingKeyboard(HWND);
    impl ExistingKeyboard {
        fn register(hwnd: HWND) -> Self {
            unsafe {
                assert_eq!(keyboard_receiver().unwrap(), None);
                RegisterRawInputDevices(
                    &[RAWINPUTDEVICE {
                        usUsagePage: KEYBOARD_USAGE_PAGE,
                        usUsage: KEYBOARD_USAGE,
                        dwFlags: Default::default(),
                        hwndTarget: hwnd,
                    }],
                    size_of::<RAWINPUTDEVICE>() as u32,
                )
                .unwrap();
            }
            Self(hwnd)
        }
    }
    impl Drop for ExistingKeyboard {
        fn drop(&mut self) {
            unsafe {
                if keyboard_receiver().unwrap() == Some(self.0) {
                    RegisterRawInputDevices(
                        &[RAWINPUTDEVICE {
                            usUsagePage: KEYBOARD_USAGE_PAGE,
                            usUsage: KEYBOARD_USAGE,
                            dwFlags: RIDEV_REMOVE,
                            hwndTarget: HWND::default(),
                        }],
                        size_of::<RAWINPUTDEVICE>() as u32,
                    )
                    .unwrap();
                }
            }
        }
    }

    #[test]
    fn null_target_registration_is_preserved_on_conflict() {
        let registration = ExistingKeyboard::register(HWND::default());
        assert!(matches!(start(Arc::new(|| {})), Err(CONFLICT)));
        assert_eq!(
            unsafe { keyboard_receiver().unwrap() },
            Some(registration.0)
        );
    }

    #[test]
    fn window_target_registration_is_preserved_on_conflict() {
        unsafe {
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!(""),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
            .unwrap();
            {
                let registration = ExistingKeyboard::register(hwnd);
                assert!(matches!(start(Arc::new(|| {})), Err(CONFLICT)));
                assert_eq!(keyboard_receiver().unwrap(), Some(registration.0));
            }
            DestroyWindow(hwnd).unwrap();
        }
    }

    #[test]
    fn receiver_start_stop_releases_only_its_registration() {
        assert_eq!(unsafe { keyboard_receiver().unwrap() }, None);
        let monitor = start(Arc::new(|| {})).unwrap();
        assert!(monitor.is_running());
        drop(monitor);
        assert_eq!(unsafe { keyboard_receiver().unwrap() }, None);
    }

    #[test]
    fn raw_modifier_fields_complete_for_left_right_and_mixed_sides() {
        for modifiers in [
            [
                (VK_SHIFT.0, 0x2a, 0),
                (VK_CONTROL.0, 0x1d, 0),
                (VK_SHIFT.0, 0x2a, 0),
            ],
            [
                (VK_SHIFT.0, 0x36, 0),
                (VK_CONTROL.0, 0x1d, RI_KEY_E0 as u16),
                (VK_SHIFT.0, 0x36, 0),
            ],
            [
                (VK_RSHIFT.0, 0, 0),
                (VK_LCONTROL.0, 0, 0),
                (VK_LSHIFT.0, 0, 0),
            ],
        ] {
            let mut receiver = state();
            for (index, (virtual_key, make_code, flags)) in modifiers.into_iter().enumerate() {
                let time = index as u64 * 200;
                receiver.key(
                    classify(virtual_key, make_code, flags),
                    true,
                    Duration::from_millis(time),
                );
                assert!(!receiver.complete);
                receiver.key(
                    classify(virtual_key, make_code, flags | RI_KEY_BREAK as u16),
                    false,
                    Duration::from_millis(time + 100),
                );
                assert_eq!(receiver.complete, index == 2);
            }
        }
    }

    #[test]
    fn packet_diagnostics_exclude_every_ordinary_virtual_key() {
        for virtual_key in 0..=u8::MAX as u16 {
            let allowed = [
                VK_SHIFT.0,
                VK_CONTROL.0,
                VK_LSHIFT.0,
                VK_RSHIFT.0,
                VK_LCONTROL.0,
                VK_RCONTROL.0,
            ]
            .contains(&virtual_key);
            assert_eq!(packet_modifier(virtual_key, 0, 0).is_some(), allowed);
        }
        assert_eq!(packet_modifier(VK_SHIFT.0, 0, 0), Some("shift-unspecified"));
    }

    fn events(receiver: &mut ReceiverState, events: &[(Key, bool, u64)]) -> usize {
        events
            .iter()
            .filter(|&&(key, down, ms)| {
                receiver.key(InputKey::Gesture(key), down, Duration::from_millis(ms));
                std::mem::take(&mut receiver.complete)
            })
            .count()
    }

    #[test]
    fn rapid_separated_taps_have_no_minimum_gap_or_debounce() {
        for gap in [0, 1, 5, 20] {
            let mut receiver = state();
            assert_eq!(
                events(
                    &mut receiver,
                    &[
                        (Key::ShiftLeft, true, 0),
                        (Key::ShiftLeft, false, gap),
                        (Key::PrimaryRight, true, gap),
                        (Key::PrimaryRight, false, gap * 2),
                        (Key::ShiftRight, true, gap * 2),
                        (Key::ShiftRight, false, gap * 3),
                    ]
                ),
                1
            );
        }
    }

    #[test]
    fn brief_adjacent_rollover_completes_only_after_final_release() {
        for overlap in [0, 1, 20, 50] {
            let mut receiver = state();
            assert_eq!(
                events(
                    &mut receiver,
                    &[
                        (Key::ShiftLeft, true, 0),
                        (Key::PrimaryRight, true, 10),
                        (Key::ShiftLeft, false, 10 + overlap),
                        (Key::ShiftRight, true, 70),
                        (Key::PrimaryRight, false, 70 + overlap),
                    ]
                ),
                0
            );
            assert_eq!(events(&mut receiver, &[(Key::ShiftRight, false, 130)]), 1);
            assert_eq!(events(&mut receiver, &[(Key::ShiftRight, false, 131)]), 0);
            assert!(taps(&mut receiver, 1000));
        }
    }

    #[test]
    fn held_chords_reverse_release_repeat_and_third_held_key_stay_rejected() {
        for invalid in [
            vec![
                (Key::ShiftLeft, true, 0),
                (Key::PrimaryLeft, true, 10),
                (Key::ShiftLeft, false, 61),
                (Key::PrimaryLeft, false, 70),
            ],
            vec![
                (Key::ShiftLeft, true, 0),
                (Key::PrimaryLeft, true, 10),
                (Key::PrimaryLeft, false, 20),
                (Key::ShiftLeft, false, 30),
            ],
            vec![
                (Key::ShiftLeft, true, 0),
                (Key::PrimaryLeft, true, 10),
                (Key::PrimaryLeft, true, 11),
                (Key::ShiftLeft, false, 20),
                (Key::PrimaryLeft, false, 30),
            ],
            vec![
                (Key::ShiftLeft, true, 0),
                (Key::PrimaryLeft, true, 10),
                (Key::ShiftRight, true, 11),
                (Key::ShiftLeft, false, 20),
                (Key::PrimaryLeft, false, 30),
                (Key::ShiftRight, false, 40),
            ],
            vec![
                (Key::ShiftLeft, true, 0),
                (Key::PrimaryLeft, true, 10),
                (Key::Other, true, 11),
                (Key::ShiftLeft, false, 20),
                (Key::PrimaryLeft, false, 30),
                (Key::Other, false, 40),
            ],
        ] {
            let mut receiver = state();
            assert_eq!(events(&mut receiver, &invalid), 0);
            assert_eq!(
                events(
                    &mut receiver,
                    &[(Key::ShiftLeft, true, 100), (Key::ShiftLeft, false, 110)]
                ),
                0
            );
            // The last isolated Shift starts a fresh proposal; cancel that
            // proposal without changing the now-released held metadata.
            receiver.sequence.cancel_pending();
            assert!(taps(&mut receiver, 1000));
        }
    }

    #[test]
    fn posted_message_times_preserve_taps_and_chords_in_a_delayed_queue_drain() {
        for (overlap, expected) in [(20, 1), (51, 0)] {
            let mut receiver = state();
            let mut completed = 0;
            for (key, down, tick) in [
                (Key::ShiftLeft, true, 1000),
                (Key::PrimaryLeft, true, 1010),
                (Key::ShiftLeft, false, 1010 + overlap),
                (Key::PrimaryLeft, false, 1100),
                (Key::ShiftLeft, true, 1110),
                (Key::ShiftLeft, false, 1120),
            ] {
                receiver.message_time(tick);
                receiver.key(InputKey::Gesture(key), down, receiver.event_time);
                completed += usize::from(std::mem::take(&mut receiver.complete));
            }
            assert_eq!(completed, expected);
        }
        let mut receiver = state();
        receiver.message_time(u32::MAX - 10);
        receiver.message_time(9);
        assert_eq!(receiver.event_time, Duration::from_millis(20));
    }

    // Pure event checks; constructing this state does not register input or
    // query an OS key state. These still require a Windows test runner.
    fn state() -> ReceiverState {
        ReceiverState {
            sequence: Sequence::default(),
            last_message_tick: None,
            event_time: Duration::ZERO,
            complete: false,
            blocking_modifiers: 0,
        }
    }
    fn taps(state: &mut ReceiverState, offset: u64) -> bool {
        for (index, key) in [Key::ShiftLeft, Key::PrimaryRight, Key::ShiftRight]
            .into_iter()
            .enumerate()
        {
            let time = offset + index as u64 * 200;
            state.key(InputKey::Gesture(key), true, Duration::from_millis(time));
            state.key(
                InputKey::Gesture(key),
                false,
                Duration::from_millis(time + 100),
            );
        }
        std::mem::take(&mut state.complete)
    }

    #[test]
    fn alt_and_win_sides_and_generic_alt_have_separate_metadata_bits() {
        for (virtual_key, flags, expected) in [
            (VK_LMENU.0, 0, 1),
            (VK_RMENU.0, 0, 2),
            (VK_MENU.0, 0, 1),
            (VK_MENU.0, RI_KEY_E0 as u16, 2),
            (VK_LWIN.0, 0, 4),
            (VK_RWIN.0, 0, 8),
        ] {
            assert_eq!(
                classify(virtual_key, 0, flags),
                InputKey::BlockingModifier(expected)
            );
        }
        assert_eq!(classify(0x41, 0, 0), InputKey::Gesture(Key::Other));
    }

    #[test]
    fn blocking_modifier_holds_cancel_taps_until_every_blocking_side_is_released() {
        for bit in [1, 2, 4, 8] {
            let mut state = state();
            state.key(InputKey::BlockingModifier(bit), true, Duration::ZERO);
            assert!(!taps(&mut state, 0));
            state.key(
                InputKey::BlockingModifier(bit),
                false,
                Duration::from_millis(700),
            );
            assert!(taps(&mut state, 1000));
        }
        let mut state = state();
        state.key(InputKey::BlockingModifier(1), true, Duration::ZERO);
        state.key(InputKey::BlockingModifier(4), true, Duration::ZERO);
        state.key(InputKey::BlockingModifier(1), false, Duration::ZERO);
        assert!(!taps(&mut state, 0));
        state.key(
            InputKey::BlockingModifier(4),
            false,
            Duration::from_millis(700),
        );
        assert!(taps(&mut state, 1000));
    }

    #[test]
    fn releasing_alt_preserves_other_and_gesture_key_down_metadata() {
        for held in [Key::Other, Key::ShiftLeft] {
            let mut state = state();
            state.key(InputKey::BlockingModifier(1), true, Duration::ZERO);
            state.key(InputKey::Gesture(held), true, Duration::ZERO);
            state.key(InputKey::BlockingModifier(1), false, Duration::ZERO);
            // Ctrl first cannot complete a proposal while the earlier key is
            // still down. Releasing Alt itself never clears that held metadata.
            state.key(
                InputKey::Gesture(Key::PrimaryLeft),
                true,
                Duration::from_millis(200),
            );
            state.key(
                InputKey::Gesture(Key::PrimaryLeft),
                false,
                Duration::from_millis(300),
            );
            assert!(!state.complete);
            state.key(InputKey::Gesture(held), false, Duration::from_millis(400));
            assert!(taps(&mut state, 1000));
        }
    }
}
