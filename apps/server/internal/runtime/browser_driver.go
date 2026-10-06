// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

const browserDriverJS = `const CDP_BASE = "http://127.0.0.1:9222";
const ACTION_TIMEOUT_MS = 5000;
const NAVIGATE_TIMEOUT_MS = 15000;
const SETTLE_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const output = (value) => {
  process.stdout.write(JSON.stringify(value) + "\n");
};

async function connectCDP() {
  let targets;
  try {
    const response = await fetch(CDP_BASE + "/json/list", { signal: AbortSignal.timeout(2000) });
    targets = await response.json();
  } catch {
    throw new Error("browser is not ready (CDP 9222)");
  }
  let target;
  if (Array.isArray(targets)) {
    target = targets.find(
      (item) => item && item.type === "page" && typeof item.webSocketDebuggerUrl === "string" && item.webSocketDebuggerUrl.length > 0
    );
  }
  if (target === undefined) {
    try {
      const response = await fetch(CDP_BASE + "/json/new?about:blank", { method: "PUT", signal: AbortSignal.timeout(2000) });
      target = await response.json();
    } catch {
      throw new Error("browser is not ready (CDP 9222)");
    }
  }
  if (!target || typeof target.webSocketDebuggerUrl !== "string" || target.webSocketDebuggerUrl.length === 0) {
    throw new Error("browser is not ready (CDP 9222)");
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("browser is not ready (CDP 9222)"));
    }, 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("browser is not ready (CDP 9222)"));
    });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message || "CDP error"));
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    if (typeof message.method === "string" && listeners.has(message.method)) {
      for (const listener of listeners.get(message.method)) {
        listener(message.params || {});
      }
    }
  });
  const send = (method, params) => {
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params: params || {} }));
    });
  };
  const once = (method, timeoutMs) => {
    return new Promise((resolve, reject) => {
      const handler = (params) => {
        clearTimeout(timer);
        const set = listeners.get(method);
        if (set) {
          set.delete(handler);
        }
        resolve(params);
      };
      const timer = setTimeout(() => {
        const set = listeners.get(method);
        if (set) {
          set.delete(handler);
        }
        reject(new Error("timeout waiting for " + method));
      }, timeoutMs);
      if (!listeners.has(method)) {
        listeners.set(method, new Set());
      }
      listeners.get(method).add(handler);
    });
  };
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const message = details.exception && details.exception.description ? details.exception.description : details.text || "evaluate failed";
      throw new Error(message);
    }
    return result.result ? result.result.value : undefined;
  };
  return {
    send,
    once,
    evaluate,
    close: () => {
      try {
        socket.close();
      } catch {}
    },
  };
}

async function runOpen(cdp, args) {
  const url = String(args.url || "");
  await cdp.send("Page.enable");
  const loaded = cdp.once("Page.loadEventFired", NAVIGATE_TIMEOUT_MS);
  await cdp.send("Page.navigate", { url });
  await loaded.catch(() => {});
  await sleep(SETTLE_MS);
  const snapshot = await cdp.evaluate(
    "JSON.stringify({title:document.title,url:location.href,text:document.body?document.body.innerText.slice(0,4000):''})"
  );
  const data = JSON.parse(snapshot);
  return { ok: true, url: data.url, title: data.title, text: data.text };
}

async function runClick(cdp, args) {
  const selector = String(args.selector || "");
  const timeout = Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : ACTION_TIMEOUT_MS;
  const expression =
    "(async () => {" +
    "const selector = " + JSON.stringify(selector) + ";" +
    "const deadline = Date.now() + " + String(timeout) + ";" +
    "while (Date.now() < deadline) {" +
    "const element = document.querySelector(selector);" +
    "if (element) {" +
    "element.scrollIntoView({ block: 'center' });" +
    "element.click();" +
    "return true;" +
    "}" +
    "await new Promise((resolve) => setTimeout(resolve, 100));" +
    "}" +
    "return false;" +
    "})()";
  const clicked = await cdp.evaluate(expression);
  if (clicked !== true) {
    return { ok: false, error: "element not found: " + selector };
  }
  const title = await cdp.evaluate("document.title");
  return { ok: true, clicked: selector, title };
}

async function runType(cdp, args) {
  const selector = args.selector ? String(args.selector) : "";
  const text = String(args.text !== undefined ? args.text : "");
  const submit = args.submit === true;
  const spec = JSON.stringify({ selector, text, submit });
  const expression =
    "(async () => {" +
    "const spec = " + spec + ";" +
    "let element = null;" +
    "if (spec.selector) {" +
    "const deadline = Date.now() + " + String(ACTION_TIMEOUT_MS) + ";" +
    "while (Date.now() < deadline) {" +
    "element = document.querySelector(spec.selector);" +
    "if (element) { break; }" +
    "await new Promise((resolve) => setTimeout(resolve, 100));" +
    "}" +
    "if (!element) { return { ok: false, error: 'element not found: ' + spec.selector }; }" +
    "} else {" +
    "element = document.activeElement;" +
    "}" +
    "if (!element) { return { ok: false, error: 'no focused element' }; }" +
    "element.focus();" +
    "const tag = element.tagName ? element.tagName.toLowerCase() : '';" +
    "if (tag === 'input' || tag === 'textarea') {" +
    "const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;" +
    "const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;" +
    "setter.call(element, spec.text);" +
    "element.dispatchEvent(new Event('input', { bubbles: true }));" +
    "element.dispatchEvent(new Event('change', { bubbles: true }));" +
    "} else {" +
    "document.execCommand('insertText', false, spec.text);" +
    "}" +
    "if (spec.submit) {" +
    "element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));" +
    "const form = element.form || (element.closest ? element.closest('form') : null);" +
    "if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); }" +
    "}" +
    "return { ok: true };" +
    "})()";
  const result = await cdp.evaluate(expression);
  if (!result || result.ok !== true) {
    return { ok: false, error: (result && result.error) || "type failed" };
  }
  const title = await cdp.evaluate("document.title");
  return { ok: true, typed: text.length, title };
}

async function main() {
  const op = process.argv[2] || "";
  const encoded = process.argv[3] || "";
  const args = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const cdp = await connectCDP();
  try {
    if (op === "open") {
      return await runOpen(cdp, args);
    }
    if (op === "click") {
      return await runClick(cdp, args);
    }
    if (op === "type") {
      return await runType(cdp, args);
    }
    return { ok: false, error: "unknown op: " + op };
  } finally {
    cdp.close();
  }
}

process.on("uncaughtException", (error) => {
  output({ ok: false, error: String(error && error.message ? error.message : error) });
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  output({ ok: false, error: String(error && error.message ? error.message : error) });
  process.exit(1);
});

(async () => {
  let result;
  try {
    result = await main();
  } catch (error) {
    output({ ok: false, error: String(error && error.message ? error.message : error) });
    process.exit(1);
    return;
  }
  output(result);
  process.exit(result && result.ok === true ? 0 : 1);
})();
`
