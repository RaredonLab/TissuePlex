import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useStore } from "./store";

// Expose store in dev for browser console / automation testing
if (import.meta.env.DEV) {
  window.__store = useStore;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
