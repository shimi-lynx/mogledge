import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { StorageTransition } from "./app/StorageTransition";
import "./app/styles.css";
// The controller owns a native event subscription; mount it once.
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(window.location.search).get("storage-transition") === "1" ? (
    <StorageTransition />
  ) : (
    <App />
  ),
);
