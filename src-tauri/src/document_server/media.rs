use super::{deny, document_csp, response};
use crate::{
    core::{Core, Session},
    knowledge::{
        self,
        media::{Window, MAX_MEDIA_BYTES, MAX_WINDOW_BYTES},
    },
};
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, Method, Request, Response, StatusCode},
};
use std::{
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    task::{Context, Poll},
};

// A single finite subrange is valid for 206 (RFC 9110 §15.3.7). Never move a
// prefix range's requested start; suffix requests end at the resource end.
fn select(headers: &HeaderMap, total: u64, head: bool) -> Result<(StatusCode, Window), StatusCode> {
    let whole = || {
        if total > MAX_WINDOW_BYTES as u64 {
            Err(StatusCode::PAYLOAD_TOO_LARGE)
        } else {
            Ok((
                StatusCode::OK,
                Window {
                    start: 0,
                    length: total as usize,
                },
            ))
        }
    };
    if head {
        return Ok((
            StatusCode::OK,
            Window {
                start: 0,
                length: 0,
            },
        ));
    }
    if headers.contains_key(header::IF_RANGE) {
        // No strong validator is issued. Do not honor a conditional range.
        return whole();
    }
    let mut ranges = headers.get_all(header::RANGE).iter();
    let Some(range) = ranges.next() else {
        return whole();
    };
    if ranges.next().is_some() {
        return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    let range = range
        .to_str()
        .map_err(|_| StatusCode::RANGE_NOT_SATISFIABLE)?;
    if range.len() > 128 {
        return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    let Some(value) = range.strip_prefix("bytes=") else {
        return whole();
    };
    let (start, end) = value
        .split_once('-')
        .ok_or(StatusCode::RANGE_NOT_SATISFIABLE)?;
    let number = |value: &str| -> Result<u64, StatusCode> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        value.parse().map_err(|_| StatusCode::RANGE_NOT_SATISFIABLE)
    };
    if total == 0 {
        return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    let window = if start.is_empty() {
        let length = number(end)?.min(total).min(MAX_WINDOW_BYTES as u64);
        if length == 0 {
            return Err(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        Window {
            start: total - length,
            length: length as usize,
        }
    } else {
        let start = number(start)?;
        let end = if end.is_empty() {
            total - 1
        } else {
            number(end)?
        };
        if start >= total || end < start {
            return Err(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        Window {
            start,
            length: (end.min(total - 1) - start + 1).min(MAX_WINDOW_BYTES as u64) as usize,
        }
    };
    Ok((StatusCode::PARTIAL_CONTENT, window))
}

struct Cancel(Arc<AtomicBool>);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

pub(super) async fn handle(
    core: Arc<Core>,
    request: Request<Body>,
    token: String,
    path: String,
    session: Session,
    mime: &'static str,
) -> Response<Body> {
    let head = request.method() == Method::HEAD;
    let Some(mut permit) = core.asset_admission.try_media_read(&token) else {
        return deny(StatusCode::SERVICE_UNAVAILABLE, head);
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel = Cancel(cancelled.clone());
    let worker_core = core.clone();
    let worker_token = token.clone();
    let headers = request.headers().clone();
    let data = tokio::task::spawn_blocking(move || {
        let active = || {
            !cancelled.load(Ordering::Acquire)
                && worker_core.session_for_token(&worker_token).is_some()
        };
        if !active() {
            return Err((StatusCode::NOT_FOUND, None));
        }
        let inspect = knowledge::media::inspect(&session.root, &session.dir, &path);
        let info = inspect.map_err(|_| (StatusCode::NOT_FOUND, None))?;
        if info.length > MAX_MEDIA_BYTES {
            return Err((StatusCode::PAYLOAD_TOO_LARGE, None));
        }
        let (status, window) =
            select(&headers, info.length, head).map_err(|status| (status, Some(info.length)))?;
        let bytes = if head {
            Vec::new()
        } else {
            knowledge::media::read_window(
                &session.root,
                &session.dir,
                &path,
                &info,
                window,
                |capacity| permit.reserve_capacity(capacity),
                active,
            )
            .map_err(|error| {
                let status = match error {
                    knowledge::ReadError::ResourceBusy => StatusCode::SERVICE_UNAVAILABLE,
                    knowledge::ReadError::Failed(_) => {
                        worker_core.asset_admission.failed_read();
                        StatusCode::NOT_FOUND
                    }
                };
                (status, None)
            })?
        };
        if !active() {
            worker_core.asset_admission.revoked();
            return Err((StatusCode::NOT_FOUND, None));
        }
        Ok((status, window, info.length, permit.response(bytes)))
    })
    .await;
    let (status, window, total, bytes) = match data {
        Ok(Ok(data)) => data,
        Ok(Err((status, total))) => {
            let mut result = deny(status, head);
            if status == StatusCode::RANGE_NOT_SATISFIABLE {
                result.headers_mut().insert(
                    header::CONTENT_RANGE,
                    format!("bytes */{}", total.unwrap()).parse().unwrap(),
                );
            }
            return result;
        }
        Err(_) => {
            core.asset_admission.worker_failure();
            return deny(StatusCode::SERVICE_UNAVAILABLE, head);
        }
    };
    if core.session_for_token(&token).is_none() {
        return deny(StatusCode::NOT_FOUND, head);
    }
    let mut result = response(
        status,
        Bytes::new(),
        mime,
        &document_csp(&core.origin, &token),
        true,
        true,
    );
    result
        .headers_mut()
        .insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    result.headers_mut().insert(
        header::CONTENT_LENGTH,
        (if head { total } else { window.length as u64 })
            .to_string()
            .parse()
            .unwrap(),
    );
    if status == StatusCode::PARTIAL_CONTENT {
        result.headers_mut().insert(
            header::CONTENT_RANGE,
            format!(
                "bytes {}-{}/{}",
                window.start,
                window.start + window.length as u64 - 1,
                total
            )
            .parse()
            .unwrap(),
        );
    }
    if !head {
        *result.body_mut() = Body::new(GrantedChunks { bytes, core, token });
    }
    result
}

struct GrantedChunks {
    bytes: Bytes,
    core: Arc<Core>,
    token: String,
}
impl http_body::Body for GrantedChunks {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        if self.bytes.is_empty() {
            return Poll::Ready(None);
        }
        if self.core.session_for_token(&self.token).is_none() {
            self.core.asset_admission.revoked();
            self.bytes = Bytes::new();
            return Poll::Ready(Some(Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Media grant revoked",
            ))));
        }
        let length = self.bytes.len().min(64 * 1024);
        let chunk = self.bytes.split_to(length);
        if self.bytes.is_empty() {
            self.bytes = Bytes::new();
        }
        Poll::Ready(Some(Ok(http_body::Frame::data(chunk))))
    }
    fn is_end_stream(&self) -> bool {
        self.bytes.is_empty()
    }
    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(self.bytes.len() as u64)
    }
}
