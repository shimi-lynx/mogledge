//! Passive session event tap. Input Monitoring is granted manually by the user.
use super::sequence;
#[path = "macos_input.rs"]
mod macos_input;
use macos_input::Input;
use std::{
    ffi::c_void,
    sync::{mpsc, Arc},
    thread,
};

type Ref = *mut c_void;
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGEventTapCreate(
        location: u32,
        placement: u32,
        options: u32,
        mask: u64,
        callback: extern "C" fn(Ref, u32, Ref, Ref) -> Ref,
        data: Ref,
    ) -> Ref;
    fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
    fn CGEventGetFlags(event: Ref) -> u64;
    fn CGEventGetTimestamp(event: Ref) -> u64;
    fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
    fn CGEventTapEnable(tap: Ref, enable: bool);
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
    fn CFMachPortInvalidate(port: Ref);
    fn CFRunLoopGetCurrent() -> Ref;
    fn CFRunLoopAddSource(loop_ref: Ref, source: Ref, mode: Ref);
    fn CFRunLoopRemoveSource(loop_ref: Ref, source: Ref, mode: Ref);
    fn CFRunLoopRun();
    fn CFRunLoopStop(loop_ref: Ref);
    fn CFRunLoopWakeUp(loop_ref: Ref);
    fn CFRunLoopSourceCreate(allocator: Ref, order: isize, context: *mut SourceContext) -> Ref;
    fn CFRunLoopSourceSignal(source: Ref);
    fn CFRelease(value: Ref);
    fn CFRetain(value: Ref) -> Ref;
    static kCFRunLoopDefaultMode: Ref;
}

#[repr(C)]
struct SourceContext {
    version: isize,
    info: Ref,
    retain: Option<extern "C" fn(Ref) -> Ref>,
    release: Option<extern "C" fn(Ref)>,
    description: Option<extern "C" fn(Ref) -> Ref>,
    equal: Option<extern "C" fn(Ref, Ref) -> bool>,
    hash: Option<extern "C" fn(Ref) -> usize>,
    schedule: Option<extern "C" fn(Ref, Ref, Ref)>,
    cancel: Option<extern "C" fn(Ref, Ref, Ref)>,
    perform: Option<extern "C" fn(Ref)>,
}
extern "C" fn stop(_: Ref) {
    unsafe { CFRunLoopStop(CFRunLoopGetCurrent()) };
}

struct Context {
    callback: Arc<dyn Fn() + Send + Sync>,
    input: Input,
    tap: Ref,
}
impl Context {
    fn reset_modifiers(&mut self) {
        let mut held = 0;
        // Query only the four modifiers once on start/recovery, not ordinary keys.
        for (code, bit) in [(56, 1), (60, 2), (55, 4), (54, 8)] {
            if unsafe { CGEventSourceKeyState(0, code) } {
                held |= bit;
            }
        }
        self.input.reset(held);
    }
}
extern "C" fn receive(_: Ref, kind: u32, event: Ref, data: Ref) -> Ref {
    // The tap's owning thread retains this context through invalidation and join.
    let context = unsafe { &mut *(data as *mut Context) };
    if matches!(kind, 0xffff_fffe | 0xffff_ffff) {
        context.reset_modifiers();
        // Re-enabling does not request permission or bypass a revoked grant.
        unsafe { CGEventTapEnable(context.tap, true) };
        return event;
    }
    if !matches!(kind, 10..=12) || event.is_null() {
        return event;
    }
    // Extract physical code/flags only for flagsChanged. Ordinary input is
    // anonymous cancellation; characters and ordinary key codes are never read.
    let (code, flags) = if kind == 12 {
        unsafe {
            (
                Some(CGEventGetIntegerValueField(event, 9)),
                CGEventGetFlags(event),
            )
        }
    } else {
        (None, 0)
    };
    let timestamp = unsafe { CGEventGetTimestamp(event) };
    if context.input.receive(kind, code, flags, timestamp) {
        (context.callback)();
    }
    event
}

pub struct Monitor {
    loop_ref: usize,
    stop_source: usize,
    thread: Option<thread::JoinHandle<()>>,
}
impl Monitor {
    pub fn is_running(&self) -> bool {
        self.thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        // A signalled run-loop source also works if Drop races initial Run().
        // No polling timer, callback blocking or input-event manipulation.
        unsafe {
            CFRunLoopSourceSignal(self.stop_source as Ref);
            CFRunLoopWakeUp(self.loop_ref as Ref);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        unsafe {
            CFRelease(self.stop_source as Ref);
            CFRelease(self.loop_ref as Ref);
        }
    }
}
pub fn permitted() -> bool {
    unsafe { CGPreflightListenEventAccess() }
}
pub fn open_permission_settings() -> Result<(), &'static str> {
    // This fixed URL only opens the OS pane. It does not grant or request access.
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
        .status()
        .map_err(|_| "ResidentPermissionSettingsUnavailable")?
        .success()
        .then_some(())
        .ok_or("ResidentPermissionSettingsUnavailable")
}
pub fn start(callback: Arc<dyn Fn() + Send + Sync>) -> Result<Monitor, &'static str> {
    if !permitted() {
        return Err("ResidentPermissionRequired");
    }
    let (ready, result) = mpsc::sync_channel(1);
    let thread = thread::Builder::new()
        .name("resident-input".into())
        .spawn(move || unsafe {
            let mut context = Box::new(Context {
                callback,
                input: Input::default(),
                tap: std::ptr::null_mut(),
            });
            // cgSessionEventTap + listenOnly: neither HID interception nor filtering.
            let tap = CGEventTapCreate(
                1,
                0,
                1,
                (1 << 10) | (1 << 11) | (1 << 12),
                receive,
                (&mut *context as *mut Context).cast(),
            );
            if tap.is_null() {
                let _ = ready.send(Err("ResidentInputUnavailable"));
                return;
            }
            context.tap = tap;
            context.reset_modifiers();
            let source = CFMachPortCreateRunLoopSource(std::ptr::null_mut(), tap, 0);
            if source.is_null() {
                CFMachPortInvalidate(tap);
                CFRelease(tap);
                let _ = ready.send(Err("ResidentInputUnavailable"));
                return;
            }
            let current = CFRunLoopGetCurrent();
            let mut stop_context = SourceContext {
                version: 0,
                info: std::ptr::null_mut(),
                retain: None,
                release: None,
                description: None,
                equal: None,
                hash: None,
                schedule: None,
                cancel: None,
                perform: Some(stop),
            };
            let stop_source = CFRunLoopSourceCreate(std::ptr::null_mut(), 0, &mut stop_context);
            if stop_source.is_null() {
                CFRelease(source);
                CFMachPortInvalidate(tap);
                CFRelease(tap);
                let _ = ready.send(Err("ResidentInputUnavailable"));
                return;
            }
            CFRunLoopAddSource(current, source, kCFRunLoopDefaultMode);
            CFRunLoopAddSource(current, stop_source, kCFRunLoopDefaultMode);
            // Monitor retains its signalling objects through join, even if the
            // owning run loop returns unexpectedly before OFF/status handling.
            CFRetain(current);
            CFRetain(stop_source);
            if ready
                .send(Ok((current as usize, stop_source as usize)))
                .is_ok()
            {
                CFRunLoopRun();
            } else {
                CFRelease(stop_source);
                CFRelease(current);
            }
            CGEventTapEnable(tap, false);
            CFMachPortInvalidate(tap);
            CFRunLoopRemoveSource(current, source, kCFRunLoopDefaultMode);
            CFRunLoopRemoveSource(current, stop_source, kCFRunLoopDefaultMode);
            CFRelease(stop_source);
            CFRelease(source);
            CFRelease(tap);
            // Context (including the four modifier bits) is discarded here.
        })
        .map_err(|_| "ResidentInputUnavailable")?;
    match result.recv() {
        Ok(Ok((loop_ref, stop_source))) => Ok(Monitor {
            loop_ref,
            stop_source,
            thread: Some(thread),
        }),
        _ => {
            let _ = thread.join();
            Err("ResidentInputUnavailable")
        }
    }
}
