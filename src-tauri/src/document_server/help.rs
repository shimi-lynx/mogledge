// Compile-time embedding keeps help available before root selection and outside
// user files. These routes never receive a document grant or storage injection.
pub const JA_PATH: &str = "/__app/help/ja.html";
pub const EN_PATH: &str = "/__app/help/en.html";
pub const CSP: &str = "default-src 'none'; sandbox; script-src 'none'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors tauri://localhost http://tauri.localhost https://tauri.localhost http://127.0.0.1:1420";

pub fn html(path: &str) -> Option<&'static str> {
    match path {
        JA_PATH => Some(include_str!("../../../src/app/help/ja.html")),
        EN_PATH => Some(include_str!("../../../src/app/help/en.html")),
        _ => None,
    }
}

pub fn allowed_url(origin: &str, url: &str) -> bool {
    // Exact serialization also rejects userinfo, queries, fragments, encoded
    // paths and a different port. Never allow arbitrary about/blob navigation.
    url.strip_prefix(origin)
        .is_some_and(|path| matches!(path, JA_PATH | EN_PATH))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_two_exact_urls_on_the_current_origin_are_navigable() {
        let origin = "http://127.0.0.1:19190";
        for path in [JA_PATH, EN_PATH] {
            assert!(allowed_url(origin, &format!("{origin}{path}")));
        }
        for url in [
            "about:srcdoc",
            "about:blank",
            "blob:http://127.0.0.1:19190/id",
            "http://127.0.0.1:19191/__app/help/ja.html",
            "http://127.0.0.1:191900/__app/help/ja.html",
            "http://user@127.0.0.1:19190/__app/help/ja.html",
            "http://127.0.0.1:19190/__app/help/ja.html?x=1",
            "http://127.0.0.1:19190/__app/help/ja.html#x",
            "http://127.0.0.1:19190/__app/help/%6aa.html",
            "http://127.0.0.1:19190/__app/help/fr.html",
            "http://127.0.0.1:19190/s/token/entry.html",
        ] {
            assert!(!allowed_url(origin, url), "{url}");
        }
    }
}
