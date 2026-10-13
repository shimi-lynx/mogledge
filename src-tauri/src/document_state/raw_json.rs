//! JSON syntax/uniqueness and canonical output without constructing payload Values.
//! Only object keys/ranges are indexed; arrays and payload strings stream to output.
use serde_json::value::RawValue;
use std::io::{self, Write};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Error {
    Invalid,
    InvalidKey,
    Capacity,
    Resource,
}
pub(crate) struct Writer {
    bytes: Vec<u8>,
    maximum: usize,
}
impl Writer {
    pub(crate) fn new(maximum: usize) -> Self {
        Self {
            bytes: Vec::new(),
            maximum,
        }
    }
    pub(crate) fn finish(self) -> Vec<u8> {
        self.bytes
    }
    pub(crate) fn string(self) -> Result<String, Error> {
        String::from_utf8(self.bytes).map_err(|_| Error::Invalid)
    }
    fn add(&mut self, value: &[u8]) -> Result<(), Error> {
        let length = self
            .bytes
            .len()
            .checked_add(value.len())
            .ok_or(Error::Capacity)?;
        if length > self.maximum {
            return Err(Error::Capacity);
        }
        self.bytes
            .try_reserve(value.len())
            .map_err(|_| Error::Resource)?;
        self.bytes.extend_from_slice(value);
        Ok(())
    }
}
impl Write for Writer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.add(bytes).map_err(|e| {
            io::Error::new(
                if e == Error::Resource {
                    io::ErrorKind::OutOfMemory
                } else {
                    io::ErrorKind::FileTooLarge
                },
                "JSON output capacity",
            )
        })?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(crate) fn serialize<T: serde::Serialize>(value: &T, maximum: usize) -> Result<Vec<u8>, Error> {
    let mut writer = Writer::new(maximum);
    serde_json::to_writer(&mut writer, value).map_err(|e| {
        if e.io_error_kind() == Some(io::ErrorKind::OutOfMemory) {
            Error::Resource
        } else if e.is_io() {
            Error::Capacity
        } else {
            Error::Invalid
        }
    })?;
    Ok(writer.finish())
}
pub(crate) fn copy(value: &str) -> Result<String, Error> {
    let mut result = String::new();
    result
        .try_reserve(value.len())
        .map_err(|_| Error::Resource)?;
    result.push_str(value);
    Ok(result)
}
/// SQLite's TEXT buffer exists already; copy it with an allocation failure
/// represented as SQLITE_NOMEM so every consumer can retain its typed mapping.
pub(crate) fn copy_sql(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<String> {
    copy(row.get_ref(index)?.as_str()?).map_err(|_| {
        rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOMEM), None)
    })
}
struct Entry {
    key: String,
    start: usize,
    end: usize,
}
struct Parser<'a> {
    text: &'a str,
    position: usize,
}
impl<'a> Parser<'a> {
    fn white(&mut self) {
        while self
            .text
            .as_bytes()
            .get(self.position)
            .is_some_and(|b| b.is_ascii_whitespace() && matches!(b, b' ' | b'\n' | b'\r' | b'\t'))
        {
            self.position += 1;
        }
    }
    fn byte(&mut self, expected: u8) -> Result<(), Error> {
        self.white();
        if self.text.as_bytes().get(self.position) != Some(&expected) {
            return Err(Error::Invalid);
        }
        self.position += 1;
        Ok(())
    }
    fn string_range(&mut self) -> Result<(usize, usize), Error> {
        self.white();
        let start = self.position;
        self.byte(b'"')?;
        loop {
            match self
                .text
                .as_bytes()
                .get(self.position)
                .copied()
                .ok_or(Error::Invalid)?
            {
                b'"' => {
                    self.position += 1;
                    return Ok((start, self.position));
                }
                b'\\' => {
                    self.position += 1;
                    match self
                        .text
                        .as_bytes()
                        .get(self.position)
                        .copied()
                        .ok_or(Error::Invalid)?
                    {
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {
                            self.position += 1
                        }
                        b'u' => {
                            self.position += 1;
                            for _ in 0..4 {
                                if !self
                                    .text
                                    .as_bytes()
                                    .get(self.position)
                                    .is_some_and(|b| b.is_ascii_hexdigit())
                                {
                                    return Err(Error::Invalid);
                                }
                                self.position += 1;
                            }
                        }
                        _ => return Err(Error::Invalid),
                    }
                }
                0..=31 => return Err(Error::Invalid),
                _ => self.position += 1,
            }
        }
    }
    fn scan(&mut self, depth: usize) -> Result<(), Error> {
        if depth >= 128 {
            return Err(Error::Invalid);
        }
        self.white();
        match self
            .text
            .as_bytes()
            .get(self.position)
            .copied()
            .ok_or(Error::Invalid)?
        {
            b'"' => {
                let (s, e) = self.string_range()?;
                if self.text.as_bytes()[s..e].contains(&b'\\') {
                    characters(&self.text[s..e], |_| Ok(()))?;
                }
            }
            b'{' => {
                self.byte(b'{')?;
                self.white();
                if self.text.as_bytes().get(self.position) == Some(&b'}') {
                    self.position += 1;
                    return Ok(());
                }
                loop {
                    let (s, e) = self.string_range()?;
                    if self.text.as_bytes()[s..e].contains(&b'\\') {
                        characters(&self.text[s..e], |_| Ok(()))?;
                    }
                    self.byte(b':')?;
                    self.scan(depth + 1)?;
                    self.white();
                    match self.text.as_bytes().get(self.position) {
                        Some(b',') => self.position += 1,
                        Some(b'}') => {
                            self.position += 1;
                            break;
                        }
                        _ => return Err(Error::Invalid),
                    }
                }
            }
            b'[' => {
                self.byte(b'[')?;
                self.white();
                if self.text.as_bytes().get(self.position) == Some(&b']') {
                    self.position += 1;
                    return Ok(());
                }
                loop {
                    self.scan(depth + 1)?;
                    self.white();
                    match self.text.as_bytes().get(self.position) {
                        Some(b',') => self.position += 1,
                        Some(b']') => {
                            self.position += 1;
                            break;
                        }
                        _ => return Err(Error::Invalid),
                    }
                }
            }
            b't' => self.literal("true")?,
            b'f' => self.literal("false")?,
            b'n' => self.literal("null")?,
            _ => {
                let range = self.number_range()?;
                number(&self.text[range.0..range.1])?;
            }
        }
        Ok(())
    }
    fn literal(&mut self, value: &str) -> Result<(), Error> {
        if !self.text[self.position..].starts_with(value) {
            return Err(Error::Invalid);
        }
        self.position += value.len();
        Ok(())
    }
    fn number_range(&mut self) -> Result<(usize, usize), Error> {
        let start = self.position;
        while self
            .text
            .as_bytes()
            .get(self.position)
            .is_some_and(|b| matches!(b, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
        {
            self.position += 1;
        }
        if start == self.position {
            return Err(Error::Invalid);
        }
        Ok((start, self.position))
    }
    fn entries(&mut self, depth: usize, app_keys: bool) -> Result<Vec<Entry>, Error> {
        self.byte(b'{')?;
        self.white();
        let mut entries = Vec::new();
        if self.text.as_bytes().get(self.position) == Some(&b'}') {
            self.position += 1;
            return Ok(entries);
        }
        loop {
            let (s, e) = self.string_range()?;
            let key = decode_string(&self.text[s..e], if app_keys { Some(80) } else { None })
                .map_err(|e| {
                    if app_keys && e == Error::Invalid {
                        Error::InvalidKey
                    } else {
                        e
                    }
                })?;
            if app_keys && entries.len() >= 128 {
                return Err(Error::Capacity);
            }
            if app_keys && !valid_key(&key) {
                return Err(Error::InvalidKey);
            }
            self.byte(b':')?;
            self.white();
            let start = self.position;
            self.scan(depth + 1)?;
            let end = self.position;
            entries.try_reserve(1).map_err(|_| Error::Resource)?;
            entries.push(Entry { key, start, end });
            self.white();
            match self.text.as_bytes().get(self.position) {
                Some(b',') => self.position += 1,
                Some(b'}') => {
                    self.position += 1;
                    break;
                }
                _ => return Err(Error::Invalid),
            }
        }
        entries.sort_unstable_by(|a, b| a.key.cmp(&b.key));
        if entries.windows(2).any(|v| v[0].key == v[1].key) {
            return Err(Error::Invalid);
        }
        Ok(entries)
    }
    fn canonical(&mut self, out: &mut Writer, depth: usize) -> Result<(), Error> {
        if depth >= 128 {
            return Err(Error::Invalid);
        }
        self.white();
        match self
            .text
            .as_bytes()
            .get(self.position)
            .copied()
            .ok_or(Error::Invalid)?
        {
            b'{' => {
                let entries = self.entries(depth, false)?;
                out.add(b"{")?;
                for (i, e) in entries.iter().enumerate() {
                    if i > 0 {
                        out.add(b",")?
                    }
                    write_string(&e.key, out)?;
                    out.add(b":")?;
                    let mut child = Parser {
                        text: &self.text[e.start..e.end],
                        position: 0,
                    };
                    child.canonical(out, depth + 1)?;
                }
                out.add(b"}")?
            }
            b'[' => {
                self.byte(b'[')?;
                out.add(b"[")?;
                self.white();
                if self.text.as_bytes().get(self.position) == Some(&b']') {
                    self.position += 1;
                } else {
                    loop {
                        self.canonical(out, depth + 1)?;
                        self.white();
                        match self.text.as_bytes().get(self.position) {
                            Some(b',') => {
                                self.position += 1;
                                out.add(b",")?
                            }
                            Some(b']') => {
                                self.position += 1;
                                break;
                            }
                            _ => return Err(Error::Invalid),
                        }
                    }
                }
                out.add(b"]")?
            }
            b'"' => {
                let (s, e) = self.string_range()?;
                let token = &self.text[s..e];
                write_decoded_string(token, out)?;
            }
            b't' => {
                self.literal("true")?;
                out.add(b"true")?
            }
            b'f' => {
                self.literal("false")?;
                out.add(b"false")?
            }
            b'n' => {
                self.literal("null")?;
                out.add(b"null")?
            }
            _ => {
                let (s, e) = self.number_range()?;
                let n = number(&self.text[s..e])?;
                serde_json::to_writer(&mut *out, &n).map_err(|e| {
                    if e.io_error_kind() == Some(io::ErrorKind::OutOfMemory) {
                        Error::Resource
                    } else if e.is_io() {
                        Error::Capacity
                    } else {
                        Error::Invalid
                    }
                })?;
            }
        }
        Ok(())
    }
}
fn number(text: &str) -> Result<serde_json::Number, Error> {
    serde_json::from_str(text).map_err(|_| Error::Invalid)
}
fn characters(token: &str, mut emit: impl FnMut(char) -> Result<(), Error>) -> Result<(), Error> {
    let mut chars = token[1..token.len() - 1].chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            emit(c)?;
            continue;
        }
        let escape = chars.next().ok_or(Error::Invalid)?;
        let c = match escape {
            '"' => '"',
            '\\' => '\\',
            '/' => '/',
            'b' => '\u{8}',
            'f' => '\u{c}',
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'u' => {
                let mut code = 0u32;
                for _ in 0..4 {
                    code = code * 16
                        + chars
                            .next()
                            .and_then(|v| v.to_digit(16))
                            .ok_or(Error::Invalid)?;
                }
                if (0xd800..=0xdbff).contains(&code) {
                    if chars.next() != Some('\\') || chars.next() != Some('u') {
                        return Err(Error::Invalid);
                    }
                    let mut low = 0u32;
                    for _ in 0..4 {
                        low = low * 16
                            + chars
                                .next()
                                .and_then(|v| v.to_digit(16))
                                .ok_or(Error::Invalid)?;
                    }
                    if !(0xdc00..=0xdfff).contains(&low) {
                        return Err(Error::Invalid);
                    }
                    code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                }
                char::from_u32(code).ok_or(Error::Invalid)?
            }
            _ => return Err(Error::Invalid),
        };
        emit(c)?;
    }
    Ok(())
}
fn decode_string(token: &str, maximum: Option<usize>) -> Result<String, Error> {
    let mut result = String::new();
    characters(token, |c| {
        if maximum.is_some_and(|m| result.len() + c.len_utf8() > m) {
            return Err(Error::Invalid);
        }
        result
            .try_reserve(c.len_utf8())
            .map_err(|_| Error::Resource)?;
        result.push(c);
        Ok(())
    })?;
    Ok(result)
}
fn write_char(c: char, out: &mut Writer) -> Result<(), Error> {
    match c {
        '"' => out.add(b"\\\""),
        '\\' => out.add(b"\\\\"),
        '\n' => out.add(b"\\n"),
        '\r' => out.add(b"\\r"),
        '\t' => out.add(b"\\t"),
        '\u{8}' => out.add(b"\\b"),
        '\u{c}' => out.add(b"\\f"),
        c if (c as u32) < 32 => {
            let b = c as u8;
            let hex = b"0123456789abcdef";
            out.add(&[
                b'\\',
                b'u',
                b'0',
                b'0',
                hex[(b >> 4) as usize],
                hex[(b & 15) as usize],
            ])
        }
        _ => out.add(c.encode_utf8(&mut [0; 4]).as_bytes()),
    }
}
fn write_decoded_string(token: &str, out: &mut Writer) -> Result<(), Error> {
    if !token.as_bytes().contains(&b'\\') {
        return out.add(token.as_bytes());
    }
    out.add(b"\"")?;
    characters(token, |c| write_char(c, out))?;
    out.add(b"\"")
}
fn write_string(text: &str, out: &mut Writer) -> Result<(), Error> {
    out.add(b"\"")?;
    for c in text.chars() {
        write_char(c, out)?;
    }
    out.add(b"\"")
}
pub(crate) fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 80
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
pub(crate) fn canonical(text: &str, maximum: usize) -> Result<String, Error> {
    let mut parser = Parser { text, position: 0 };
    let mut out = Writer::new(maximum);
    parser.canonical(&mut out, 0)?;
    parser.white();
    if parser.position != text.len() {
        return Err(Error::Invalid);
    }
    out.string()
}
pub(crate) fn app_map(text: &str) -> Result<Vec<(String, &RawValue)>, Error> {
    let mut p = Parser { text, position: 0 };
    let entries = p.entries(0, true)?;
    p.white();
    if p.position != text.len() {
        return Err(Error::Invalid);
    }
    let mut result = Vec::new();
    result
        .try_reserve(entries.len())
        .map_err(|_| Error::Resource)?;
    for e in entries {
        let raw = serde_json::from_str(&text[e.start..e.end]).map_err(|_| Error::Invalid)?;
        result.push((e.key, raw));
    }
    Ok(result)
}
pub(crate) fn merge(values: &[(String, &RawValue)], maximum: usize) -> Result<String, Error> {
    let mut out = Writer::new(maximum);
    out.add(b"{")?;
    for (i, (key, raw)) in values.iter().enumerate() {
        if i > 0 {
            out.add(b",")?
        }
        write_string(key, &mut out)?;
        out.add(b":")?;
        let mut parser = Parser {
            text: raw.get(),
            position: 0,
        };
        parser.canonical(&mut out, 1)?;
        parser.white();
        if parser.position != raw.get().len() {
            return Err(Error::Invalid);
        }
    }
    out.add(b"}")?;
    out.string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_matches_value_for_nested_unicode_numbers() {
        for text in [
            r#" {"z":[true,false,null,1e2,-0.2],"a":{"b":"\ud83d\ude00\n","a":"日本語"}} "#,
            r#"[0,-0,1.0,18446744073709551616,{"\/":"\b\f\r\t\u0000"}]"#,
        ] {
            let expected =
                serde_json::to_string(&serde_json::from_str::<serde_json::Value>(text).unwrap())
                    .unwrap();
            assert_eq!(canonical(text, 1000).unwrap(), expected);
        }
    }
    #[test]
    fn duplicate_depth_nonfinite_and_unicode_are_rejected() {
        for text in [
            r#"{"a":1,"\u0061":2}"#,
            r#"{"a":{"x":0,"x":1}}"#,
            r#"[1e999]"#,
            r#""\ud800""#,
            r#"[01]"#,
            r#"[1,]"#,
            r#"{"a":0}tail"#,
        ] {
            assert_eq!(canonical(text, 1000), Err(Error::Invalid), "{text}");
        }
        assert_eq!(
            canonical(&format!("{}0{}", "[".repeat(128), "]".repeat(128)), 1000),
            Err(Error::Invalid)
        );
    }
    #[test]
    fn dense_array_does_not_allocate_a_value_tree_and_writer_is_finite() {
        let text = format!("[{}0]", "0,".repeat(100000));
        assert_eq!(canonical(&text, text.len()).unwrap(), text);
        assert_eq!(canonical(&text, 5), Err(Error::Capacity));
        assert_eq!(app_map(r#"{"a":1,"a":2}"#).err(), Some(Error::Invalid));
    }
}
