//! One explicit modifier/key registration. No renderer plugin permission is exposed.
use crate::resident_model::Shortcut as Preference;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub struct Registration {
    app: AppHandle,
    shortcut: Shortcut,
    active: Arc<AtomicBool>,
    registered: bool,
}
impl Registration {
    pub fn start(app: &AppHandle, preference: &Preference) -> Result<Self, String> {
        let Preference::Custom {
            control,
            alt,
            shift,
            meta,
            key,
        } = preference
        else {
            return Err("ResidentShortcutInvalid".into());
        };
        if !preference.valid() {
            return Err("ResidentShortcutInvalid".into());
        }
        let code: Code = key.parse().map_err(|_| "ResidentShortcutInvalid")?;
        let mut modifiers = Modifiers::empty();
        for (enabled, flag) in [
            (*control, Modifiers::CONTROL),
            (*alt, Modifiers::ALT),
            (*shift, Modifiers::SHIFT),
            (*meta, Modifiers::META),
        ] {
            if enabled {
                modifiers |= flag;
            }
        }
        let shortcut = Shortcut::new(Some(modifiers), code);
        let active = Arc::new(AtomicBool::new(false));
        let activated = active.clone();
        #[cfg(target_os = "macos")]
        let pressed = AtomicBool::new(false);
        app.global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                // Windows registers MOD_NOREPEAT. Its provider's delayed Released
                // notification must not suppress a subsequent quick physical press.
                #[cfg(target_os = "macos")]
                {
                    if !super::shortcut_transaction::press_edge(
                        &pressed,
                        event.state() == ShortcutState::Pressed,
                    ) {
                        return;
                    }
                }
                if event.state() == ShortcutState::Pressed && activated.load(Ordering::Acquire) {
                    super::restore(app, true);
                }
            })
            .map_err(|_| "ResidentShortcutUnavailable")?;
        Ok(Self {
            app: app.clone(),
            shortcut,
            active,
            registered: true,
        })
    }
    pub fn activate(&self) {
        self.active.store(true, Ordering::Release);
    }
    pub fn stop(&mut self) -> Result<(), String> {
        if self.registered {
            self.app
                .global_shortcut()
                .unregister(self.shortcut)
                .map_err(|_| "ResidentShortcutReleaseUnavailable")?;
            self.registered = false;
        }
        self.active.store(false, Ordering::Release);
        Ok(())
    }
    pub fn is_running(&self) -> bool {
        self.registered
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        let _ = self.stop();
    }
}
