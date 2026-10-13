//! DWM still draws every caption button, including native hover/close states.

use windows::Win32::{
    Foundation::HWND,
    Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_COLOR_DEFAULT, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
    },
    UI::{
        Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
        WindowsAndMessaging::{SystemParametersInfoW, SPI_GETHIGHCONTRAST},
    },
};

fn caption_colors(high_contrast: bool) -> (u32, u32, u32) {
    if high_contrast {
        return (0, DWMWA_COLOR_DEFAULT, DWMWA_COLOR_DEFAULT);
    }
    // COLORREF stores BGR: match the shell's #151f2c and #eef5fc colors.
    (1, 0x002c_1f15, 0x00fc_f5ee)
}

pub(super) unsafe fn apply(hwnd: HWND) {
    let mut contrast = HIGHCONTRASTW {
        cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
        ..Default::default()
    };
    let high_contrast = SystemParametersInfoW(
        SPI_GETHIGHCONTRAST,
        contrast.cbSize,
        Some(&mut contrast as *mut HIGHCONTRASTW as _),
        Default::default(),
    )
    .map(|()| contrast.dwFlags.contains(HCF_HIGHCONTRASTON))
    .unwrap_or(true);
    let (dark, background, text) = caption_colors(high_contrast);
    for (attribute, value) in [
        (DWMWA_USE_IMMERSIVE_DARK_MODE, dark),
        (DWMWA_CAPTION_COLOR, background),
        (DWMWA_TEXT_COLOR, text),
    ] {
        // These attributes require Windows 11 build 22000. Unsupported styling
        // must retain the OS defaults without breaking startup or window controls.
        let _ = DwmSetWindowAttribute(
            hwnd,
            attribute,
            &value as *const u32 as _,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{caption_colors, DWMWA_COLOR_DEFAULT};

    #[test]
    fn high_contrast_removes_every_custom_caption_color() {
        assert_eq!(
            caption_colors(true),
            (0, DWMWA_COLOR_DEFAULT, DWMWA_COLOR_DEFAULT)
        );
        let (dark, background, text) = caption_colors(false);
        assert_eq!(dark, 1);
        assert_eq!(background, 0x002c_1f15);
        assert_eq!(text, 0x00fc_f5ee);
        assert_ne!(background, text);
    }
}
