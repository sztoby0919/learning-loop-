import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";

import { App } from "./App.js";
import { readPreferences, applyThemeToDocument } from "./preferences.js";
import "./styles.css";

// Apply theme before React mounts to prevent flash
applyThemeToDocument(readPreferences().theme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
