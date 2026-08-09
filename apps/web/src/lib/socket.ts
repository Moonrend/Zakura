"use client";

/**
 * 共享 Socket.IO 连接：整页一条，引用计数管理。
 *
 * 传输降级：**不要指定 transports**，用默认的 ["polling", "websocket"] ——
 * 先以 HTTP long-polling 握手（可穿任何反向代理 / CDN / Next rewrites），
 * 再静默探测升级到 WebSocket；探测失败就留在 polling 继续工作。
 *
 * 反例（本文件曾经的写法）：transports: ["websocket", "polling"]。
 * engine.io-client 的 transports 是「按序尝试」，而 tryAllTransports 默认为
 * false —— 首个传输失败时不会尝试下一个，而是直接 _onClose，降级形同虚设
 * （见 engine.io-client/build/cjs/socket.js 的 _onError）。
 *
 * 鉴权 token 走握手 auth 载荷，且用**函数形式**：socket.io-client 在每次
 * onopen 时重新求值，因此 token 轮换、首帧尚无 token 的场景都能自愈。
 */
import { io, type Socket } from "socket.io-client";

/** 最后一个持有者归还后的宽限期：避免路由切换 / StrictMode 双挂载反复重连 */
const IDLE_GRACE_MS = 5_000;

let socket: Socket | null = null;
let refCount = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

function getToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("zakura_session") ?? "";
}

function bindGlobalListeners() {
  if (listenersBound || typeof window === "undefined") return;
  listenersBound = true;

  // 登录/登出换 token：断开即可，auth 是函数形式，重连时自动读到新 token
  window.addEventListener("zakura_session_changed", () => {
    if (!socket) return;
    socket.disconnect();
    if (refCount > 0) socket.connect();
  });

  // 回到前台 / 恢复网络：跳过退避立即重连，保证状态新鲜
  const wake = () => {
    if (refCount > 0 && socket?.disconnected) socket.connect();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  window.addEventListener("online", wake);
}

function teardown() {
  if (!socket) return;
  socket.close();
  socket = null;
}

/**
 * 取得共享连接并持有一份引用。调用返回的 release() 归还；
 * 最后一个持有者归还 IDLE_GRACE_MS 后断开连接。
 */
export function acquireSocket(): { socket: Socket; release: () => void } {
  bindGlobalListeners();

  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (!socket) {
    socket = io({
      path: "/api/socket.io",
      // 必须与服务端一致关闭尾斜杠：默认会请求 `/api/socket.io/?EIO=4`，
      // 而 Next.js（trailingSlash: false）会 308 重定向掉尾斜杠，导致服务端
      // 前缀匹配失败、请求落到 Hono 返回 401，实时功能整体失效。
      addTrailingSlash: false,
      // 每次连接尝试重新求值，token 轮换自动生效
      auth: (cb: (data: Record<string, unknown>) => void) => cb({ token: getToken() }),
      // transports 刻意不设，见文件头注释
      rememberUpgrade: true,
      withCredentials: false,
    });
  }

  refCount += 1;
  const held = socket;

  let released = false;
  return {
    socket: held,
    release: () => {
      if (released) return;
      released = true;
      refCount = Math.max(0, refCount - 1);
      if (refCount > 0 || socket !== held) return;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (refCount === 0) teardown();
      }, IDLE_GRACE_MS);
    },
  };
}
