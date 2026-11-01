import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useStore } from "./store";
import { installGlobalErrorReporting } from "./utils/clientLog";

// Uncaught errors and unhandled rejections go to the backend log file as well
// as the console, so a trainee's "it just stopped" leaves something to read.
installGlobalErrorReporting();

// Expose store in dev for browser console / automation testing
if (import.meta.env.DEV) {
  window.__store = useStore;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
