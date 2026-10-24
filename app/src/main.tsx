import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import BrowserWindow from "./BrowserWindow";
import { isBrowserWindow } from "./windowEvents";
import { ctrlOpensOutside } from "./outside";
import "./styles.css";

ctrlOpensOutside();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isBrowserWindow() ? <BrowserWindow /> : <App />}
  </StrictMode>,
);
