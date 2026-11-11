// Must precede every Excalidraw import so the editor loads fonts from this
// origin rather than its CDN fallback, which the production CSP blocks.
import "./app/excalidraw-asset-path";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import "@excalidraw/excalidraw/index.css";
import "@fontsource/gochi-hand";
import "@fontsource-variable/nunito";

import { AppProviders, createAppQueryClient } from "./app/providers";
import { createAppRouter } from "./app/router";
import "./app/styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

const queryClient = createAppQueryClient();
const router = createAppRouter();

createRoot(root).render(
  <StrictMode>
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
