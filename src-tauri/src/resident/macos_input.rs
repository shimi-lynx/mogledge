//! Decode the passive Mac tap without retaining ordinary key identities.
use super::sequence::{Key, KeyEvent, Sequence};
use std::time::Duration;

#[derive(Default)]
pub struct Input {
    sequence: Sequence,
    held: u8,
    last_timestamp: Option<u64>,
}
impl Input {
    pub fn reset(&mut self, held: u8) {
        *self = Self::default();
        self.held = held;
        // Keys held at startup/recovery cannot become the first tap.
        for (key, bit) in [
            (Key::ShiftLeft, 1),
            (Key::ShiftRight, 2),
            (Key::PrimaryLeft, 4),
            (Key::PrimaryRight, 8),
        ] {
            if held & bit != 0 {
                self.sequence.input(KeyEvent::Down(key), Duration::ZERO);
            }
        }
        self.sequence.cancel_pending();
    }

    pub fn receive(&mut self, kind: u32, code: Option<i64>, flags: u64, timestamp: u64) -> bool {
        // CoreGraphics timestamps are nanoseconds since startup. Delivery can
        // be delayed or batched; callback wall time changes the tap/rollover limits.
        if timestamp == 0 || self.last_timestamp.is_some_and(|last| timestamp < last) {
            // A bad time cannot prove keys were released, including anonymous input.
            self.sequence.cancel_pending();
            return false;
        }
        self.last_timestamp = Some(timestamp);
        let input = match kind {
            10 => KeyEvent::Down(Key::Other),
            11 => KeyEvent::Up(Key::Other),
            12 => {
                let (key, bit, flag) = match code {
                    Some(56) => (Key::ShiftLeft, 1, 1 << 17),
                    Some(60) => (Key::ShiftRight, 2, 1 << 17),
                    Some(55) => (Key::PrimaryLeft, 4, 1 << 20),
                    Some(54) => (Key::PrimaryRight, 8, 1 << 20),
                    _ => {
                        self.sequence.cancel_pending();
                        return false;
                    }
                };
                if flags & ((1 << 18) | (1 << 19) | (1 << 23)) != 0 {
                    self.sequence.cancel_pending();
                }
                let down = self.held & bit == 0 && flags & flag != 0;
                if down {
                    self.held |= bit;
                    KeyEvent::Down(key)
                } else {
                    self.held &= !bit;
                    KeyEvent::Up(key)
                }
            }
            _ => return false,
        };
        self.sequence.input(input, Duration::from_nanos(timestamp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SHIFT: u64 = 1 << 17;
    const CMD: u64 = 1 << 20;
    fn modifier(input: &mut Input, code: i64, flags: u64, ms: u64) -> bool {
        input.receive(12, Some(code), flags, (ms + 1) * 1_000_000)
    }
    fn taps(input: &mut Input, codes: [i64; 3], start: u64, duration: u64) -> bool {
        for (index, code) in codes.into_iter().enumerate() {
            let ms = start + index as u64 * (duration + 10);
            let flag = if index == 1 { CMD } else { SHIFT };
            assert!(!modifier(input, code, flag, ms));
            let recalled = modifier(input, code, 0, ms + duration);
            if index == 2 {
                return recalled;
            }
            assert!(!recalled);
        }
        false
    }
    #[test]
    fn both_sides_of_shift_and_command_recall_once_and_can_repeat() {
        for shift in [56, 60] {
            for cmd in [55, 54] {
                let mut input = Input::default();
                assert!(taps(&mut input, [shift, cmd, shift], 0, 50));
                assert!(!modifier(&mut input, shift, 0, 200));
                assert!(taps(&mut input, [shift, cmd, shift], 300, 50));
            }
        }
    }
    #[test]
    fn queued_long_holds_remain_invalid_and_event_times_preserve_short_rollover() {
        let mut input = Input::default();
        // Run immediately as a batch; the OS times still reject a long tap.
        assert!(!taps(&mut input, [56, 55, 56], 0, 401));
        assert!(taps(&mut input, [56, 55, 56], 2000, 50));
        for (code, flags, ms) in [
            (56, SHIFT, 3000),
            (55, SHIFT | CMD, 3010),
            (56, CMD, 3020),
            (60, SHIFT | CMD, 3030),
            (55, SHIFT, 3040),
        ] {
            assert!(!modifier(&mut input, code, flags, ms));
        }
        assert!(modifier(&mut input, 60, 0, 3050));
    }
    #[test]
    fn control_is_not_command_and_other_modifiers_cancel() {
        for (code, flag) in [(59, 1 << 18), (62, 1 << 18), (58, 1 << 19), (63, 1 << 23)] {
            let mut input = Input::default();
            modifier(&mut input, 56, SHIFT, 0);
            modifier(&mut input, 56, 0, 50);
            modifier(&mut input, code, flag, 60);
            modifier(&mut input, code, 0, 70);
            modifier(&mut input, 55, CMD, 80);
            modifier(&mut input, 55, 0, 90);
            modifier(&mut input, 56, SHIFT, 100);
            assert!(!modifier(&mut input, 56, 0, 110));
            assert!(taps(&mut input, [60, 54, 60], 2000, 50));
        }
    }
    #[test]
    fn long_rollover_reverse_release_and_total_timeout_do_not_recall() {
        for events in [
            [
                (56, SHIFT, 0),
                (55, SHIFT | CMD, 10),
                (56, CMD, 61),
                (55, 0, 70),
            ],
            [
                (56, SHIFT, 0),
                (55, SHIFT | CMD, 10),
                (55, SHIFT, 20),
                (56, 0, 30),
            ],
        ] {
            let mut input = Input::default();
            for (code, flags, ms) in events {
                assert!(!modifier(&mut input, code, flags, ms));
            }
            modifier(&mut input, 56, SHIFT, 80);
            assert!(!modifier(&mut input, 56, 0, 90));
            assert!(taps(&mut input, [56, 55, 56], 2000, 50));
        }
        let mut input = Input::default();
        for (code, flags, ms) in [
            (56, SHIFT, 0),
            (56, 0, 100),
            (55, CMD, 1000),
            (55, 0, 1100),
            (56, SHIFT, 1499),
            (56, 0, 1501),
        ] {
            assert!(!modifier(&mut input, code, flags, ms));
        }
    }
    #[test]
    fn startup_and_recovery_discard_partial_sequence_and_held_modifiers() {
        let mut input = Input::default();
        modifier(&mut input, 56, SHIFT, 0);
        modifier(&mut input, 56, 0, 50);
        input.reset(4);
        modifier(&mut input, 55, 0, 60);
        modifier(&mut input, 56, SHIFT, 70);
        assert!(!modifier(&mut input, 56, 0, 80));
        input.reset(0);
        assert!(taps(&mut input, [56, 55, 56], 100, 50));
    }
    #[test]
    fn ordinary_events_cancel_without_a_key_code_or_text() {
        let mut input = Input::default();
        modifier(&mut input, 56, SHIFT, 0);
        modifier(&mut input, 56, 0, 50);
        assert!(!input.receive(10, None, 0, 60_000_000));
        assert!(!input.receive(12, Some(55), CMD, 0));
        assert!(!taps(&mut input, [56, 55, 56], 100, 50));
        assert!(!input.receive(11, None, 0, 300_000_000));
        assert!(taps(&mut input, [56, 55, 56], 400, 50));
    }
    #[test]
    fn missing_or_reversed_timestamp_cannot_complete_a_pending_sequence() {
        for timestamp in [0, 1] {
            let mut input = Input::default();
            modifier(&mut input, 56, SHIFT, 100);
            modifier(&mut input, 56, 0, 150);
            assert!(!input.receive(12, Some(55), CMD, timestamp));
            modifier(&mut input, 55, 0, 200);
            modifier(&mut input, 56, SHIFT, 210);
            assert!(!modifier(&mut input, 56, 0, 220));
            input.reset(0);
            assert!(taps(&mut input, [56, 55, 56], 300, 50));
        }
    }
}
