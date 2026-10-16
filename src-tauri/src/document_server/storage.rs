use crate::{
    core::Core,
    document_state::{self, RawStateRequest, StateError},
};
use axum::{
    body::{Body, Bytes},
    http::{header, Method, Request, Response, StatusCode},
};
use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

pub const ENDPOINT: &str = "__mogledge_storage_v1__";
// Existing inline HTML may retain the old endpoint. Both names pass through
// exactly the same token, origin, admission and commit authorization checks.
const LEGACY_ENDPOINT: &str = "__my_knowledge_storage_v1__";
pub fn token(path: &str) -> Option<&str> {
    let (token, tail) = path.strip_prefix("/s/")?.split_once('/')?;
    ((tail == ENDPOINT || tail == LEGACY_ENDPOINT)
        && token.len() == 64
        && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then_some(token)
}
fn response(status: StatusCode, value: impl serde::Serialize) -> Response<Body> {
    response_bytes(status, Bytes::from(serde_json::to_vec(&value).unwrap()))
}

// The permit belongs to the actual bytes, including any slices handed to the
// transport. Dropping/polling just the Body must not release buffered data.
struct AdmittedBytes {
    bytes: Vec<u8>,
    _admission: tokio::sync::OwnedSemaphorePermit,
    _processing: tokio::sync::OwnedSemaphorePermit,
}
impl AsRef<[u8]> for AdmittedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

const RESPONSE_CHUNK_BYTES: usize = 64 * 1024;

struct ResponseChunks(Bytes);
impl http_body::Body for ResponseChunks {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        if self.0.is_empty() {
            return Poll::Ready(None);
        }
        let length = self.0.len().min(RESPONSE_CHUNK_BYTES);
        let chunk = self.0.split_to(length);
        // Empty Bytes::split_to can keep the original owner's reference. Once
        // exhausted, only transport-held chunks should retain admission.
        if self.0.is_empty() {
            self.0 = Bytes::new();
        }
        Poll::Ready(Some(Ok(http_body::Frame::data(chunk))))
    }

    fn is_end_stream(&self) -> bool {
        self.0.is_empty()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(self.0.len() as u64)
    }
}

fn response_bytes(status: StatusCode, bytes: Bytes) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "null")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "POST")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Content-Type")
        .header(header::VARY, "Origin")
        .body(Body::new(ResponseChunks(bytes)))
        .unwrap()
}
fn error(error: StateError) -> Response<Body> {
    let status = match error {
        StateError::InvalidRequest => StatusCode::BAD_REQUEST,
        StateError::Revoked | StateError::IdentityChanged => StatusCode::FORBIDDEN,
        StateError::QuotaExceeded | StateError::CapacityExceeded => StatusCode::PAYLOAD_TOO_LARGE,
        StateError::Conflict | StateError::IdentityConfirmationRequired => StatusCode::CONFLICT,
        StateError::Unavailable | StateError::Corrupt | StateError::ResourceUnavailable => {
            StatusCode::SERVICE_UNAVAILABLE
        }
    };
    response(
        status,
        serde_json::json!({"version":1,"error":error.code()}),
    )
}

// Grow only for received bytes. An advertised quota or Content-Length never
// reserves memory, and allocation failure leaves the stored document untouched.
async fn collect_body(body: Body, maximum: usize) -> Result<Vec<u8>, StateError> {
    if maximum == 0 {
        return Err(StateError::Unavailable);
    }
    let mut body = std::pin::pin!(body);
    let mut bytes = Vec::new();
    while let Some(frame) =
        std::future::poll_fn(|cx| http_body::Body::poll_frame(body.as_mut(), cx)).await
    {
        let frame = frame.map_err(|_| StateError::InvalidRequest)?;
        if let Ok(data) = frame.into_data() {
            let length = bytes
                .len()
                .checked_add(data.len())
                .filter(|length| *length <= maximum)
                .ok_or(StateError::CapacityExceeded)?;
            bytes
                .try_reserve(length - bytes.len())
                .map_err(|_| StateError::ResourceUnavailable)?;
            bytes.extend_from_slice(&data);
        }
    }
    Ok(bytes)
}
pub async fn handle(core: Arc<Core>, request: Request<Body>) -> Response<Body> {
    let token = token(request.uri().path()).unwrap().to_owned();
    let expected_host = core.origin.strip_prefix("http://").unwrap();
    if request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(expected_host)
        || request
            .headers()
            .get(header::ORIGIN)
            .is_some_and(|value| value != "null")
    {
        return error(StateError::Revoked);
    }
    if request.uri().query().is_some() {
        return error(StateError::InvalidRequest);
    }
    if request.method() == Method::OPTIONS {
        if request
            .headers()
            .get(header::ACCESS_CONTROL_REQUEST_METHOD)
            .is_none_or(|value| value != "POST")
            || request
                .headers()
                .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
                .is_some_and(|value| {
                    value
                        .to_str()
                        .map_or(true, |value| !value.eq_ignore_ascii_case("content-type"))
                })
        {
            return error(StateError::InvalidRequest);
        }
        if core.session_for_token(&token).is_none() {
            return error(StateError::Revoked);
        }
        let Some(store) = core.document_state.get() else {
            return error(StateError::Unavailable);
        };
        // Preflights share admission so they cannot create an unbounded queue
        // of blocking authorization workers while large POSTs are in flight.
        let admission = match store.request_slots.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => return error(StateError::Conflict),
        };
        let result = tokio::task::spawn_blocking(move || {
            let _admission = admission;
            let _gate = core.gate.lock().map_err(|_| StateError::Unavailable)?;
            document_state::authorized_session(&core, &token).map(|_| ())
        })
        .await;
        return match result {
            Ok(Ok(())) => response(StatusCode::OK, serde_json::json!({"version":1})),
            Ok(Err(failure)) => error(failure),
            Err(_) => error(StateError::Unavailable),
        };
    }
    if request.method() != Method::POST {
        return response(
            StatusCode::METHOD_NOT_ALLOWED,
            serde_json::json!({"version":1,"error":"MethodNotAllowed"}),
        );
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|value| {
            !value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("application/json")
        })
    {
        return error(StateError::InvalidRequest);
    }
    // Reject stale/unknown tokens without polling their body. Identity and
    // revocation are checked again under the commit gate after collection.
    if core.session_for_token(&token).is_none() {
        return error(StateError::Revoked);
    }
    let Some(store) = core.document_state.get() else {
        return error(StateError::Unavailable);
    };
    // No admission wait queue: reject overload before buffering any bytes.
    // One payload is buffered/processed; the other three admitted requests wait
    // with unpolled bodies. No lifecycle or commit lock is held while collecting.
    let admission = match store.request_slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return error(StateError::Conflict),
    };
    let processing = match store.processing_slot.clone().acquire_owned().await {
        Ok(permit) => permit,
        Err(_) => return error(StateError::Unavailable),
    };
    // A tab may have closed while this request waited behind another payload.
    // Do not collect its stale body; final identity checks still share COMMIT's gate.
    if core.session_for_token(&token).is_none() {
        return error(StateError::Revoked);
    }
    let maximum = crate::storage_limits::maximum_request_bytes();
    let body = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        collect_body(request.into_body(), maximum),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(failure)) => return error(failure),
        Err(_) => return error(StateError::ResourceUnavailable),
    };
    // Parse and serialize large JSON off the async worker. Serialize the v1
    // response directly, avoiding another full Value tree and string copy.
    match tokio::task::spawn_blocking(move || {
        // Owned permits stay with the worker even if the HTTP caller cancels.
        // Keep processing with the response bytes and transport slices, so a
        // slow reader cannot overlap large buffers with the next request.
        let parsed: RawStateRequest<'_> =
            serde_json::from_slice(&body).map_err(|_| StateError::InvalidRequest)?;
        // Native prepares these bytes before COMMIT; no fallible serialization
        // after a successful write can masquerade as a rejected operation.
        let bytes = document_state::operate_raw_bytes(&core, &token, parsed)?;
        drop(body);
        let bytes = Bytes::from_owner(AdmittedBytes {
            bytes,
            _admission: admission,
            _processing: processing,
        });
        Ok::<_, StateError>(response_bytes(StatusCode::OK, bytes))
    })
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(failure)) => error(failure),
        Err(_) => error(StateError::Unavailable),
    }
}

pub fn inject(
    bytes: Vec<u8>,
    core: &Core,
    session: &crate::core::Session,
    permit: &mut super::admission::ReadPermit,
) -> Result<Vec<u8>, crate::knowledge::ReadError> {
    // Fixed descriptor/scripts fit within the scratch allowance already held;
    // charge both original and output before allocating the injected copy.
    let descriptor = serde_json::json!({"version":1,"endpoint":format!("{}/s/{}/{}", core.origin, session.token, ENDPOINT),
        "maximumDocumentBytes":crate::storage_limits::maximum_document_bytes(),
        "available":core.document_state.get().is_some() && session.storage_identity.is_some()});
    let keyboard = include_str!("keyboard.js").replace(
        "__MOGLEDGE_KEYBOARD_TOKEN__",
        &serde_json::to_string(&session.token).unwrap(),
    );
    let links = include_str!("links.js").replace(
        "__MOGLEDGE_LINK_TOKEN__",
        &serde_json::to_string(&session.token).unwrap(),
    );
    let export = include_str!("export.js").replace(
        "__MOGLEDGE_EXPORT_TOKEN__",
        &serde_json::to_string(&session.token).unwrap(),
    );
    let export_adapter = include_str!("../../../.agents/skills/mogledge-html/assets/export.js");
    let script = format!("<script>(()=>{{const descriptor=Object.freeze({descriptor});for(const name of ['__MOGLEDGE_STORAGE_V1__','__MY_KNOWLEDGE_STORAGE_V1__'])Object.defineProperty(globalThis,name,{{value:descriptor,writable:false,configurable:false}});}})();{keyboard}{links}{export}{export_adapter}</script>");
    // Preserve the leading doctype and standards mode. No source file is edited.
    let text = std::str::from_utf8(&bytes).unwrap_or_default();
    let offset = insertion_offset(text);
    let output_capacity = bytes.len() + script.len();
    permit.reserve_capacity(bytes.capacity() + output_capacity)?;
    let mut output = Vec::with_capacity(output_capacity);
    output.extend_from_slice(&bytes[..offset]);
    output.extend_from_slice(script.as_bytes());
    output.extend_from_slice(&bytes[offset..]);
    drop(bytes);
    permit.reserve_capacity(output.capacity())?;
    Ok(output)
}

fn insertion_offset(text: &str) -> usize {
    let mut rest = text.trim_start_matches('\u{feff}');
    loop {
        rest = rest.trim_start_matches(|ch: char| ch.is_ascii_whitespace());
        if let Some(comment) = rest.strip_prefix("<!--") {
            if let Some(tail) = comment
                .strip_prefix('>')
                .or_else(|| comment.strip_prefix("->"))
            {
                rest = tail;
                continue;
            }
            let end = [
                comment.find("-->").map(|at| at + 3),
                comment.find("--!>").map(|at| at + 4),
            ]
            .into_iter()
            .flatten()
            .min();
            let Some(end) = end else {
                return text.len();
            };
            rest = &comment[end..];
        } else if rest.starts_with("<?")
            || (rest.starts_with("<!")
                && !rest
                    .get(..9)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("<!doctype")))
        {
            let Some(end) = rest.find('>') else {
                return text.len();
            };
            rest = &rest[end + 1..];
        } else {
            break;
        }
    }
    let leading = text.len() - rest.len();
    if !rest
        .get(..9)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("<!doctype"))
    {
        return leading;
    }
    // HTML DOCTYPE identifiers abort at '>' even inside quotes; following the
    // tokenizer also keeps scripts in a malformed suffix behind our descriptor.
    // https://html.spec.whatwg.org/multipage/parsing.html#doctype-system-identifier-(single-quoted)-state
    rest.find('>').map_or(text.len(), |at| leading + at + 1)
}

#[cfg(test)]
mod tests {
    use super::insertion_offset;
    use super::*;
    use http_body_util::{BodyExt, Full};
    use std::{
        convert::Infallible,
        sync::atomic::{AtomicUsize, Ordering},
    };
    use tower::ServiceExt;

    #[test]
    fn canonical_and_legacy_endpoints_require_the_same_exact_token_path() {
        let valid = "a".repeat(64);
        for endpoint in [ENDPOINT, LEGACY_ENDPOINT] {
            assert_eq!(
                token(&format!("/s/{valid}/{endpoint}")),
                Some(valid.as_str())
            );
            assert_eq!(token(&format!("/s/short/{endpoint}")), None);
            assert_eq!(token(&format!("/s/{}/{endpoint}", "g".repeat(64))), None);
            assert_eq!(token(&format!("/s/{valid}/{endpoint}/extra")), None);
        }
    }

    fn fixture() -> (
        Arc<Core>,
        tempfile::TempDir,
        tempfile::TempDir,
        String,
        String,
    ) {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("app.html"),
            "<!doctype html><p>fixture</p>",
        )
        .unwrap();
        let core = Core::new(19061);
        assert!(core
            .document_state
            .set(document_state::DocumentState::new(state.path().to_owned()).unwrap())
            .is_ok());
        let snapshot = core.select(root.path(), false).unwrap();
        core.watcher.lock().unwrap().take();
        let grant = || {
            let tab = core
                .create_tab(
                    snapshot.workspace_id.as_deref().unwrap(),
                    &snapshot.view_id,
                    "app.html",
                )
                .unwrap();
            let url = core
                .open(
                    snapshot.workspace_id.as_deref().unwrap(),
                    &snapshot.view_id,
                    &tab,
                    1,
                )
                .unwrap();
            let token =
                crate::document_server::decode_path(url.strip_prefix(&core.origin).unwrap())
                    .unwrap()
                    .0;
            (tab, token)
        };
        let (tab, token) = grant();
        (core, root, state, tab, token)
    }

    fn request(core: &Core, token: &str, body: Body) -> Request<Body> {
        Request::builder()
            .uri(format!("/s/{token}/{ENDPOINT}"))
            .method(Method::POST)
            .header(header::HOST, core.origin.strip_prefix("http://").unwrap())
            .header(header::CONTENT_TYPE, "application/json")
            .body(body)
            .unwrap()
    }

    fn operate(
        core: &Core,
        token: &str,
        op: &str,
        value: Option<serde_json::Value>,
    ) -> document_state::StateResponse {
        document_state::operate(
            core,
            token,
            serde_json::from_value(
                serde_json::json!({"version":1,"op":op,"key":"large","value":value}),
            )
            .unwrap(),
        )
        .unwrap()
    }

    async fn wait_admitted(core: &Core, count: usize) {
        let started = std::time::Instant::now();
        while core
            .document_state
            .get()
            .unwrap()
            .request_slots
            .available_permits()
            != document_state::MAX_ACTIVE_REQUESTS - count
        {
            assert!(
                started.elapsed() < std::time::Duration::from_secs(3),
                "Admission did not reach expected count"
            );
            tokio::task::yield_now().await;
        }
    }

    fn unpolled_body(polls: Arc<AtomicUsize>) -> Body {
        Body::new(
            Full::new(axum::body::Bytes::from_static(b"invalid JSON")).map_frame(move |frame| {
                polls.fetch_add(1, Ordering::SeqCst);
                frame
            }),
        )
    }

    #[tokio::test]
    async fn collection_checks_actual_bytes_at_the_technical_boundary() {
        let maximum = 16 * 1024;
        assert_eq!(
            collect_body(Body::from(vec![b' '; maximum]), maximum)
                .await
                .unwrap()
                .len(),
            maximum
        );
        assert_eq!(
            collect_body(Body::from(vec![b' '; maximum + 1]), maximum)
                .await
                .unwrap_err(),
            StateError::CapacityExceeded
        );
        assert_eq!(
            collect_body(Body::empty(), 0).await.unwrap_err(),
            StateError::Unavailable
        );
    }

    #[tokio::test]
    async fn queued_revoked_grant_is_rejected_before_its_body_is_polled() {
        let (core, _root, _state, tab, token) = fixture();
        let store = core.document_state.get().unwrap();
        let processing = store.processing_slot.clone().acquire_owned().await.unwrap();
        let polls = Arc::new(AtomicUsize::new(0));
        let router = crate::document_server::router(core.clone());
        let queued = request(&core, &token, unpolled_body(polls.clone()));
        let pending = tokio::spawn(async move { router.oneshot(queued).await.unwrap() });
        wait_admitted(&core, 1).await;
        let snapshot = core.snapshot();
        core.close_tab(
            snapshot.workspace_id.as_deref().unwrap(),
            &snapshot.view_id,
            &tab,
        )
        .unwrap();
        drop(processing);
        assert_eq!(pending.await.unwrap().status(), StatusCode::FORBIDDEN);
        assert_eq!(polls.load(Ordering::SeqCst), 0);
        wait_admitted(&core, 0).await;
        assert_eq!(store.processing_slot.available_permits(), 1);
    }

    #[tokio::test]
    async fn admission_bounds_large_bodies_before_parse_and_rejects_unknown_tokens_without_polling()
    {
        let (core, _root, _state, _tab, token) = fixture();
        let saved = operate(
            &core,
            &token,
            "write",
            Some(serde_json::json!({"data":"saved"})),
        );
        let database = rusqlite::Connection::open(_state.path().join("state.sqlite")).unwrap();
        let quota = || {
            database
                .query_row("SELECT bytes,documents,generation FROM quota", [], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .unwrap()
        };
        let before_quota = quota();
        let store = core.document_state.get().unwrap();
        // Hold processing: all admitted bodies stay unpolled until it is released.
        let processing = store.processing_slot.clone().acquire_owned().await.unwrap();
        let body = format!(
            "{{\"version\":1,\"op\":\"write\",\"key\":\"large\",\"value\":{{\"data\":\"{}\"}}}}",
            "あ".repeat(1700000)
        );
        let mut tasks = tokio::task::JoinSet::new();
        let body_polls = Arc::new(AtomicUsize::new(0));
        for _ in 0..document_state::MAX_ACTIVE_REQUESTS {
            let router = crate::document_server::router(core.clone());
            let polls = body_polls.clone();
            let payload = Full::new(Bytes::from(body.clone())).map_frame(move |frame| {
                polls.fetch_add(1, Ordering::SeqCst);
                frame
            });
            let request = request(&core, &token, Body::new(payload));
            tasks.spawn(async move { router.oneshot(request).await.unwrap() });
        }
        wait_admitted(&core, document_state::MAX_ACTIVE_REQUESTS).await;
        assert_eq!(body_polls.load(Ordering::SeqCst), 0);
        for candidate in [&token, &"0".repeat(64)] {
            let polls = Arc::new(AtomicUsize::new(0));
            let result = crate::document_server::router(core.clone())
                .oneshot(request(&core, candidate, unpolled_body(polls.clone())))
                .await
                .unwrap();
            assert_eq!(
                result.status(),
                if candidate == &token {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::FORBIDDEN
                }
            );
            assert_eq!(
                polls.load(Ordering::SeqCst),
                0,
                "Rejected bodies must never be buffered/parsed"
            );
        }
        let after_busy = operate(&core, &token, "read", None);
        let preflight = Request::builder()
            .uri(format!("/s/{token}/{ENDPOINT}"))
            .method(Method::OPTIONS)
            .header(header::HOST, core.origin.strip_prefix("http://").unwrap())
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .body(Body::empty())
            .unwrap();
        let preflight = crate::document_server::router(core.clone())
            .oneshot(preflight)
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::CONFLICT);
        assert_eq!(after_busy.value, saved.value);
        assert_eq!(after_busy.revision, saved.revision);
        assert_eq!(quota(), before_quota);
        assert!(core.gate.try_lock().is_ok());
        drop(processing);
        while let Some(result) = tasks.join_next().await {
            assert_eq!(result.unwrap().status(), StatusCode::OK);
        }
        assert_eq!(
            store.request_slots.available_permits(),
            document_state::MAX_ACTIVE_REQUESTS
        );
        assert_eq!(store.processing_slot.available_permits(), 1);
        let retry = crate::document_server::router(core.clone())
            .oneshot(request(
                &core,
                &token,
                Body::from(r#"{"version":1,"op":"read","key":"large"}"#),
            ))
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn slow_body_allows_other_view_and_revoke_then_releases_capacity_on_failure_and_cancel() {
        let (core, _root, _state, tab, token) = fixture();
        let saved = operate(
            &core,
            &token,
            "write",
            Some(serde_json::json!({"data":"saved"})),
        );
        let finished = Arc::new(tokio::sync::Notify::new());
        let end = finished.clone();
        // A delayed body end models a slow/chunked client: collection cannot
        // finish until released, but no lifecycle or commit lock is held.
        let slow = Full::new(axum::body::Bytes::from_static(
            br#"{"version":1,"op":"write","key":"large","value":{"data":"unacknowledged"}}"#,
        ))
        .with_trailers(async move {
            end.notified().await;
            None::<Result<axum::http::HeaderMap, Infallible>>
        });
        let router = crate::document_server::router(core.clone());
        let slow_request = request(&core, &token, Body::new(slow));
        let pending = tokio::spawn(async move { router.oneshot(slow_request).await.unwrap() });
        wait_admitted(&core, 1).await;
        assert!(core.gate.try_lock().is_ok());
        assert_eq!(
            core.document_state
                .get()
                .unwrap()
                .processing_slot
                .available_permits(),
            0
        );
        let snapshot = core.snapshot();
        let other_tab = core
            .create_tab(
                snapshot.workspace_id.as_deref().unwrap(),
                &snapshot.view_id,
                "app.html",
            )
            .unwrap();
        let other_url = core
            .open(
                snapshot.workspace_id.as_deref().unwrap(),
                &snapshot.view_id,
                &other_tab,
                1,
            )
            .unwrap();
        let other =
            crate::document_server::decode_path(other_url.strip_prefix(&core.origin).unwrap())
                .unwrap()
                .0;
        // A view can still open and use Core while HTTP payloads serialize.
        assert_eq!(operate(&core, &other, "read", None).value, saved.value);
        core.close_tab(
            snapshot.workspace_id.as_deref().unwrap(),
            &snapshot.view_id,
            &tab,
        )
        .unwrap();
        let polls = Arc::new(AtomicUsize::new(0));
        let revoked = crate::document_server::router(core.clone())
            .oneshot(request(&core, &token, unpolled_body(polls.clone())))
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::FORBIDDEN);
        assert_eq!(polls.load(Ordering::SeqCst), 0);
        finished.notify_one();
        assert_eq!(pending.await.unwrap().status(), StatusCode::FORBIDDEN);
        let after = operate(&core, &other, "read", None);
        assert_eq!(after.value, saved.value);
        assert_eq!(after.revision, saved.revision);
        // Cancellation during a slow body returns its admission slot.
        let hold = Arc::new(tokio::sync::Notify::new());
        let slow = Full::new(axum::body::Bytes::from_static(b"{")).with_trailers(async move {
            hold.notified().await;
            None::<Result<axum::http::HeaderMap, Infallible>>
        });
        let router = crate::document_server::router(core.clone());
        let slow_request = request(&core, &other, Body::new(slow));
        let cancelled = tokio::spawn(async move { router.oneshot(slow_request).await.unwrap() });
        wait_admitted(&core, 1).await;
        cancelled.abort();
        assert!(cancelled.await.unwrap_err().is_cancelled());
        wait_admitted(&core, 0).await;
        let failed = crate::document_server::router(core.clone())
            .oneshot(request(&core, &other, Body::from("bad JSON")))
            .await
            .unwrap();
        assert_eq!(failed.status(), StatusCode::BAD_REQUEST);
        wait_admitted(&core, 0).await;
    }

    #[tokio::test]
    async fn unconsumed_responses_hold_admission_until_data_is_consumed_or_dropped() {
        let (core, _root, _state, _tab, token) = fixture();
        let value = serde_json::json!({"data":"あ".repeat(1700000)});
        let write = crate::document_server::router(core.clone())
            .oneshot(request(
                &core,
                &token,
                Body::from(
                    serde_json::json!({"version":1,"op":"write","key":"large","value":value})
                        .to_string(),
                ),
            ))
            .await
            .unwrap();
        assert_eq!(write.status(), StatusCode::OK);
        // Commit has already succeeded while its acknowledgement is unread.
        let saved = operate(&core, &token, "read", None);
        assert_eq!(saved.value, value);
        let database = rusqlite::Connection::open(_state.path().join("state.sqlite")).unwrap();
        let quota = || {
            database
                .query_row("SELECT bytes,documents,generation FROM quota", [], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .unwrap()
        };
        let before_quota = quota();
        let store = core.document_state.get().unwrap();
        let mut pending = tokio::task::JoinSet::new();
        let polls = Arc::new(AtomicUsize::new(0));
        for _ in 1..document_state::MAX_ACTIVE_REQUESTS {
            let router = crate::document_server::router(core.clone());
            let seen = polls.clone();
            let payload = Full::new(Bytes::from_static(
                br#"{"version":1,"op":"read","key":"large"}"#,
            ))
            .map_frame(move |frame| {
                seen.fetch_add(1, Ordering::SeqCst);
                frame
            });
            let request = request(&core, &token, Body::new(payload));
            pending.spawn(async move { router.oneshot(request).await.unwrap() });
        }
        wait_admitted(&core, document_state::MAX_ACTIVE_REQUESTS).await;
        assert_eq!(store.processing_slot.available_permits(), 0);
        assert_eq!(polls.load(Ordering::SeqCst), 0);
        assert!(core.gate.try_lock().is_ok());
        let rejected_polls = Arc::new(AtomicUsize::new(0));
        let busy = crate::document_server::router(core.clone())
            .oneshot(request(
                &core,
                &token,
                unpolled_body(rejected_polls.clone()),
            ))
            .await
            .unwrap();
        assert_eq!(busy.status(), StatusCode::CONFLICT);
        assert_eq!(rejected_polls.load(Ordering::SeqCst), 0);
        let mut body = write.into_body();
        let mut consumed = Vec::new();
        let mut retained = None;
        let mut chunks = 0;
        while let Some(frame) = body.frame().await {
            let bytes = frame.unwrap().into_data().unwrap();
            assert!(!bytes.is_empty() && bytes.len() <= RESPONSE_CHUNK_BYTES);
            chunks += 1;
            consumed.extend_from_slice(&bytes);
            retained = Some(bytes.slice(..1));
        }
        assert!(chunks > 1);
        drop(body);
        let decoded: serde_json::Value = serde_json::from_slice(&consumed).unwrap();
        assert_eq!(
            decoded,
            serde_json::json!({"version":1,"value":value,"revision":saved.revision})
        );
        drop(consumed);
        // Transport-held slices keep both permits after Body exhaustion.
        assert_eq!(store.request_slots.available_permits(), 0);
        assert_eq!(store.processing_slot.available_permits(), 0);
        assert_eq!(polls.load(Ordering::SeqCst), 0);
        drop(retained);
        while let Some(result) = pending.join_next().await {
            let response = result.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let mut partial = response.into_body();
            let first = partial.frame().await.unwrap().unwrap().into_data().unwrap();
            assert_eq!(first.len(), RESPONSE_CHUNK_BYTES);
            drop(partial);
            assert_eq!(store.processing_slot.available_permits(), 0);
            drop(first);
        }
        wait_admitted(&core, 0).await;
        assert_eq!(store.processing_slot.available_permits(), 1);
        let after = operate(&core, &token, "read", None);
        assert_eq!(after.value, saved.value);
        assert_eq!(after.revision, saved.revision);
        assert_eq!(quota(), before_quota);
    }

    #[tokio::test]
    async fn tcp_slow_readers_keep_response_admission_and_disconnect_allows_retry() {
        use std::io::{Read, Write};
        let (core, _root, _state, _tab, token) = fixture();
        let saved = operate(
            &core,
            &token,
            "write",
            Some(serde_json::json!({"data":"あ".repeat(1700000)})),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = crate::document_server::router(core.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let host = core.origin.strip_prefix("http://").unwrap().to_owned();
        let open = || {
            let host = host.clone();
            let token = token.clone();
            tokio::task::spawn_blocking(move || {
                let mut client = std::net::TcpStream::connect(address).unwrap();
                client
                    .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                    .unwrap();
                let body = r#"{"version":1,"op":"read","key":"large"}"#;
                write!(client, "POST /s/{token}/{ENDPOINT} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    client.read_exact(&mut byte).unwrap();
                    headers.push(byte[0]);
                    assert!(headers.len() < 4096);
                }
                (String::from_utf8(headers).unwrap(), client)
            })
        };
        let (headers, client) = open().await.unwrap();
        assert!(headers.starts_with("HTTP/1.1 200"));
        let mut pending = tokio::task::JoinSet::new();
        for _ in 1..document_state::MAX_ACTIVE_REQUESTS {
            let opening = open();
            pending.spawn(async move { opening.await.unwrap() });
        }
        wait_admitted(&core, document_state::MAX_ACTIVE_REQUESTS).await;
        assert_eq!(
            core.document_state
                .get()
                .unwrap()
                .processing_slot
                .available_permits(),
            0
        );
        let (headers, busy) = open().await.unwrap();
        assert!(headers.starts_with("HTTP/1.1 409"));
        drop(busy);
        drop(client); // Transport drops the unread bytes and lets one waiter run.
        while let Some(result) = pending.join_next().await {
            let (headers, mut retry) = result.unwrap();
            assert!(headers.starts_with("HTTP/1.1 200"));
            let bytes = tokio::task::spawn_blocking(move || {
                let mut bytes = Vec::new();
                retry.read_to_end(&mut bytes).unwrap();
                bytes
            })
            .await
            .unwrap();
            let decoded: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                decoded,
                serde_json::json!({"version":1,"value":saved.value,"revision":saved.revision})
            );
        }
        wait_admitted(&core, 0).await;
        let after = operate(&core, &token, "read", None);
        assert_eq!(after.value, saved.value);
        assert_eq!(after.revision, saved.revision);
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn cancelling_http_waiter_keeps_permits_in_uncancellable_blocking_work() {
        let (core, _root, _state, _tab, token) = fixture();
        let saved = operate(
            &core,
            &token,
            "write",
            Some(serde_json::json!({"data":"saved"})),
        );
        let holder_core = core.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _gate = holder_core.gate.lock().unwrap();
            ready_tx.send(()).unwrap();
            release_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
        });
        ready_rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        let router = crate::document_server::router(core.clone());
        let request = request(
            &core,
            &token,
            Body::from(r#"{"version":1,"op":"read","key":"large"}"#),
        );
        let pending = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
        wait_admitted(&core, 1).await;
        let started = std::time::Instant::now();
        while core
            .document_state
            .get()
            .unwrap()
            .processing_slot
            .available_permits()
            != 0
        {
            assert!(started.elapsed() < std::time::Duration::from_secs(3));
            tokio::task::yield_now().await;
        }
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        // The worker still waits for commit authorization; aborting its async
        // caller cannot release either slot and admit another heavy parse.
        assert_eq!(
            core.document_state
                .get()
                .unwrap()
                .request_slots
                .available_permits(),
            document_state::MAX_ACTIVE_REQUESTS - 1
        );
        assert_eq!(
            core.document_state
                .get()
                .unwrap()
                .processing_slot
                .available_permits(),
            0
        );
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        wait_admitted(&core, 0).await;
        let after = operate(&core, &token, "read", None);
        assert_eq!(after.value, saved.value);
        assert_eq!(after.revision, saved.revision);
    }
    #[test]
    fn injected_copy_reserves_original_and_output_before_allocation() {
        let (core, _root, _state, _tab, token) = fixture();
        let session = core.session_for_token(&token).unwrap();
        let mut permit = core.asset_admission.try_read(&token).unwrap();
        let original = vec![b' '; 2 * 1024 * 1024];
        permit.reserve_capacity(original.capacity()).unwrap();
        let output = inject(original, &core, &session, &mut permit).unwrap();
        let report = serde_json::to_value(core.asset_admission.report()).unwrap();
        assert!(
            report["peakReservedBytes"].as_u64().unwrap()
                >= (super::super::admission::READ_RESERVATION_BYTES
                    + 2 * 1024 * 1024
                    + output.capacity()) as u64
        );
        assert_eq!(
            report["reservedBytes"],
            super::super::admission::READ_RESERVATION_BYTES + output.capacity()
        );
        drop(output);
        drop(permit);

        let mut held = core.asset_admission.try_read(&token).unwrap();
        // Leave enough for the original but too little for original+injected copy.
        held.reserve_capacity(
            super::super::admission::MAX_BYTES_PER_TOKEN
                - 2 * super::super::admission::READ_RESERVATION_BYTES
                - 400 * 1024,
        )
        .unwrap();
        let mut permit = core.asset_admission.try_read(&token).unwrap();
        let original = vec![b' '; 256 * 1024];
        permit.reserve_capacity(original.capacity()).unwrap();
        assert_eq!(
            inject(original, &core, &session, &mut permit),
            Err(crate::knowledge::ReadError::ResourceBusy)
        );

        drop(permit);
        drop(held);
        assert_eq!(
            serde_json::to_value(core.asset_admission.report()).unwrap()["reservedBytes"],
            0
        );
    }

    #[test]
    fn injection_preserves_doctype_comments_quotes_and_runs_before_source_scripts() {
        for prefix in [
            "<!doctype html>",
            "\u{feff} <!-- > comment -->\n<!DOCTYPE html>",
            "<!-- comment --!> <!doctype html SYSTEM 'about:legacy-compat'>",
            "<?ignored><!bogus><!doctype html>",
            "<!--><!---><!doctype html>",
        ] {
            let html = format!("{prefix}<script>source()</script>");
            assert_eq!(insertion_offset(&html), prefix.len());
        }
        assert_eq!(insertion_offset(" \n<script>source()</script>"), 2);
        assert_eq!(insertion_offset("<!-- unclosed"), 13);
        let malformed = "<!doctype html SYSTEM 'a><script>source()</script>b'>";
        assert_eq!(
            insertion_offset(malformed),
            malformed.find('>').unwrap() + 1
        );
    }
}
