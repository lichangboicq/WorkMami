import React from "react";
import ReactDOM from "react-dom/client";
import "antd/dist/reset.css";
import App from "./App";
import "./styles.css";
import { makeInvoke } from "./dev-bridge";

// 初始化 invoke：Tauri runtime 下走原生，否则走本地 axum bridge。
// 同步 store.init 依赖它拿到真实数据，所以必须在 React 根渲染前 await 完。
(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__WM_INVOKE__ = await makeInvoke();

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
})();
