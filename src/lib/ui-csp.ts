// Development pages arrive directly from Vite and lack Tauri's bundled CSP header.
// Apply the same restrictive policy before the user can mount a document iframe.
export function installUiCsp(origin: string) {
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.origin !== origin
  ) {
    throw new Error("Invalid document server origin");
  }
  const previous = document.querySelector<HTMLMetaElement>("meta[data-mogledge-csp]");
  if (previous) {
    if (previous.dataset.mogledgeCsp !== origin) throw new Error("Document server origin changed");
    return;
  }
  const dev = import.meta.env.DEV ? " http://127.0.0.1:1420 ws://127.0.0.1:1420" : "";
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.dataset.mogledgeCsp = origin;
  meta.content =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src ipc: http://ipc.localhost" +
    dev +
    "; frame-src " +
    origin +
    "; object-src 'none'; base-uri 'none'; form-action 'none'";
  document.head.prepend(meta);
}
