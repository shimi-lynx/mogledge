import { useT } from "../../lib/i18n";
import { useEffect, useRef } from "react";
import type { DocumentTab } from "../../lib/types";
import d2Icon from "../../assets/mogledge-d2-128.png";
import d2Icon2x from "../../assets/mogledge-d2-256.png";

export function DocumentViewer({
  url,
  loading,
  title,
  navigation,
  zoom = 100,
  zoomAnchor,
  zoomRequest,
}: {
  url: string | null;
  loading: boolean;
  title?: string;
  navigation?: DocumentTab["navigation"];
  zoom?: number;
  zoomAnchor?: DocumentTab["zoomAnchor"];
  zoomRequest?: number;
}) {
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const renderZoom = (useGestureAnchor = true) => {
    if (!url) return;
    const token = new URL(url).pathname.match(/^\/s\/([a-f0-9]{64})\//)?.[1];
    if (token)
      frame.current?.contentWindow?.postMessage(
        {
          type: "mogledge-document-zoom-render-v1",
          token,
          zoom,
          anchor: useGestureAnchor ? (zoomAnchor ?? null) : null,
        },
        "*",
      );
  };
  const anchor = () => {
    if (!navigation || !url) return;
    const token = new URL(url).pathname.match(/^\/s\/([a-f0-9]{64})\//)?.[1];
    if (token)
      frame.current?.contentWindow?.postMessage(
        {
          type: "mogledge-anchor-v1",
          token,
          fragment: navigation.fragment,
          request: navigation.request,
        },
        "*",
      );
  };
  useEffect(() => renderZoom(), [zoom, zoomAnchor, zoomRequest, url]);
  useEffect(() => {
    if (navigation) {
      renderZoom(false);
      anchor();
    }
  }, [navigation, url]);
  return (
    <div className="viewer" aria-busy={loading}>
      {url ? (
        <iframe
          ref={frame}
          onLoad={() => {
            renderZoom(false);
            anchor();
          }}
          key={url}
          src={url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={title ?? t("HTMLドキュメント")}
          data-testid="document-frame"
        />
      ) : (
        <div className="welcome">
          <img
            className="welcome-symbol"
            src={d2Icon}
            srcSet={`${d2Icon} 1x, ${d2Icon2x} 2x`}
            width={92}
            height={92}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
          <p className="eyebrow">{t("ローカルの文書")}</p>
        </div>
      )}
      {loading && url && <div className="loading-line" aria-label={t("読み込み中")} />}
    </div>
  );
}
