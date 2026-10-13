//! Recognizes ordered modifier taps without retaining ordinary key identities.
use std::time::Duration;

pub const SEQUENCE_WINDOW: Duration = Duration::from_millis(1500);
pub const TAP_WINDOW: Duration = Duration::from_millis(400);
// A fast transition may press the next modifier just before releasing the
// previous one. Accept only this brief rollover, with releases in tap order.
pub const ROLLOVER_WINDOW: Duration = Duration::from_millis(50);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    ShiftLeft,
    ShiftRight,
    PrimaryLeft,
    PrimaryRight,
    Other,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyEvent {
    Down(Key),
    Up(Key),
    Reset,
}
#[derive(Default)]
pub struct Sequence {
    held: u8,
    other_held: bool,
    step: u8,
    started: Option<Duration>,
    pressed: Option<(Key, Duration)>,
    next_pressed: Option<(Key, Duration)>,
}
#[cfg(windows)]
pub(crate) struct DiagnosticState {
    pub step: u8,
    pub held_modifiers: u8,
    pub anonymous_key_held: bool,
}
impl Sequence {
    #[cfg(windows)]
    pub(crate) fn diagnostic_state(&self) -> DiagnosticState {
        DiagnosticState {
            step: self.step,
            held_modifiers: self.held,
            anonymous_key_held: self.other_held,
        }
    }
    /// Cancel a proposal while preserving key-down metadata. A timeout or an
    /// unrelated modifier must not turn a held ordinary key into neutral state.
    pub fn cancel_pending(&mut self) {
        self.cancel();
    }
    fn cancel(&mut self) {
        self.step = 0;
        self.started = None;
        self.pressed = None;
        self.next_pressed = None;
    }
    pub fn input(&mut self, event: KeyEvent, now: Duration) -> bool {
        if self
            .started
            .is_some_and(|start| now.saturating_sub(start) > SEQUENCE_WINDOW)
            || self
                .pressed
                .is_some_and(|(_, start)| now.saturating_sub(start) > TAP_WINDOW)
        {
            self.cancel();
        }
        let (key, down) = match event {
            KeyEvent::Down(key) => (key, true),
            KeyEvent::Up(key) => (key, false),
            KeyEvent::Reset => {
                *self = Self::default();
                return false;
            }
        };
        let bit = match key {
            Key::ShiftLeft => 1,
            Key::ShiftRight => 2,
            Key::PrimaryLeft => 4,
            Key::PrimaryRight => 8,
            Key::Other => {
                // Anonymous transient state; no ordinary key identity or text.
                // With overlapping ordinary keys, one release cannot prove all
                // keys are up. The caller still requires release-all-before-use.
                self.other_held = down;
                self.cancel();
                return false;
            }
        };
        if down {
            let held = self.held;
            self.held |= bit;
            if held != 0 {
                let next_expected = match self.step {
                    0 => 12,
                    1 => 3,
                    _ => 0,
                };
                if held & bit == 0
                    && held.count_ones() == 1
                    && !self.other_held
                    && self.pressed.is_some()
                    && self.next_pressed.is_none()
                    && bit & next_expected != 0
                {
                    self.next_pressed = Some((key, now));
                } else {
                    self.cancel();
                }
                return false;
            }
            let expected = if self.step == 1 { 12 } else { 3 };
            if self.other_held || bit & expected == 0 {
                self.cancel();
                return false;
            }
            if self.step == 0 {
                self.started = Some(now);
            }
            self.pressed = Some((key, now));
            return false;
        }
        let held = self.held;
        self.held &= !bit;
        if let Some((next, started)) = self.next_pressed {
            if self.pressed.is_some_and(|(pressed, _)| pressed == key)
                && held.count_ones() == 2
                && now.saturating_sub(started) <= ROLLOVER_WINDOW
            {
                self.next_pressed = None;
                self.pressed = Some((next, started));
                self.step += 1;
            } else {
                self.cancel();
            }
            return false;
        }
        if held != bit || self.pressed.is_none_or(|(pressed, _)| pressed != key) {
            self.cancel();
            return false;
        }
        self.pressed = None;
        self.step += 1;
        if self.step == 3 {
            self.cancel();
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(sequence: &mut Sequence, event: KeyEvent, ms: u64) -> bool {
        sequence.input(event, Duration::from_millis(ms))
    }
    fn taps(sequence: &mut Sequence, offset: u64) -> bool {
        for (index, key) in [Key::ShiftRight, Key::PrimaryLeft, Key::ShiftLeft]
            .into_iter()
            .enumerate()
        {
            assert!(!event(
                sequence,
                KeyEvent::Down(key),
                offset + index as u64 * 200
            ));
            let complete = event(
                sequence,
                KeyEvent::Up(key),
                offset + index as u64 * 200 + 100,
            );
            if index == 2 {
                return complete;
            }
            assert!(!complete);
        }
        false
    }
    #[test]
    fn fires_once_only_after_three_releases_and_accepts_either_side() {
        let mut sequence = Sequence::default();
        assert!(taps(&mut sequence, 0));
        assert!(!event(&mut sequence, KeyEvent::Up(Key::ShiftLeft), 501));
        assert!(taps(&mut sequence, 1000));
    }
    #[test]
    fn chords_repeat_wrong_order_and_other_keys_cancel() {
        for invalid in [
            KeyEvent::Down(Key::ShiftLeft),
            KeyEvent::Down(Key::ShiftRight),
            KeyEvent::Down(Key::PrimaryLeft),
            KeyEvent::Down(Key::Other),
            KeyEvent::Up(Key::Other),
        ] {
            let mut sequence = Sequence::default();
            event(&mut sequence, KeyEvent::Down(Key::ShiftLeft), 0);
            assert!(!event(&mut sequence, invalid, 10));
            event(&mut sequence, KeyEvent::Up(Key::ShiftLeft), 100);
            event(&mut sequence, KeyEvent::Up(Key::ShiftRight), 110);
            event(&mut sequence, KeyEvent::Up(Key::PrimaryLeft), 120);
            assert!(!event(&mut sequence, KeyEvent::Down(Key::PrimaryLeft), 200));
            assert!(!event(&mut sequence, KeyEvent::Up(Key::PrimaryLeft), 300));
            assert!(!event(&mut sequence, KeyEvent::Down(Key::ShiftLeft), 400));
            assert!(!event(&mut sequence, KeyEvent::Up(Key::ShiftLeft), 500));
            event(&mut sequence, KeyEvent::Reset, 600);
            assert!(taps(&mut sequence, 1000));
        }
    }
    #[test]
    fn long_tap_total_timeout_and_reset_cannot_complete() {
        let mut sequence = Sequence::default();
        event(&mut sequence, KeyEvent::Down(Key::ShiftLeft), 0);
        assert!(!event(&mut sequence, KeyEvent::Up(Key::ShiftLeft), 401));
        event(&mut sequence, KeyEvent::Down(Key::PrimaryLeft), 500);
        event(&mut sequence, KeyEvent::Up(Key::PrimaryLeft), 600);
        assert!(!event(&mut sequence, KeyEvent::Down(Key::ShiftLeft), 700));
        assert!(!event(&mut sequence, KeyEvent::Up(Key::ShiftLeft), 800));
        event(&mut sequence, KeyEvent::Down(Key::PrimaryLeft), 1450);
        assert!(!event(&mut sequence, KeyEvent::Up(Key::PrimaryLeft), 1550));
        event(&mut sequence, KeyEvent::Reset, 1600);
        assert!(taps(&mut sequence, 2000));
    }
    #[test]
    fn short_rollover_preserves_release_order_and_reset_discards_pending_taps() {
        let mut sequence = Sequence::default();
        for (key, down, ms) in [
            (Key::ShiftRight, true, 0),
            (Key::PrimaryLeft, true, 10),
            (Key::ShiftRight, false, 20),
            (Key::ShiftLeft, true, 30),
            (Key::PrimaryLeft, false, 40),
        ] {
            assert!(!event(
                &mut sequence,
                if down {
                    KeyEvent::Down(key)
                } else {
                    KeyEvent::Up(key)
                },
                ms
            ));
        }
        assert!(event(&mut sequence, KeyEvent::Up(Key::ShiftLeft), 50));
        event(&mut sequence, KeyEvent::Down(Key::ShiftRight), 100);
        event(&mut sequence, KeyEvent::Down(Key::PrimaryLeft), 110);
        event(&mut sequence, KeyEvent::Reset, 120);
        assert!(!event(&mut sequence, KeyEvent::Up(Key::ShiftRight), 130));
        assert!(!event(&mut sequence, KeyEvent::Up(Key::PrimaryLeft), 140));
        assert!(taps(&mut sequence, 1000));
    }
    #[test]
    fn ordinary_hold_survives_timeouts_and_cancel_until_release() {
        let mut sequence = Sequence::default();
        event(&mut sequence, KeyEvent::Down(Key::Other), 0);
        assert!(!taps(&mut sequence, 2000));
        sequence.cancel_pending();
        assert!(!taps(&mut sequence, 5000));
        event(&mut sequence, KeyEvent::Up(Key::Other), 6000);
        assert!(taps(&mut sequence, 7000));
        event(&mut sequence, KeyEvent::Down(Key::Other), 8000);
        event(&mut sequence, KeyEvent::Reset, 9000);
        assert!(taps(&mut sequence, 10000));
    }
}
