#!/usr/bin/env node
/*
 * pico-piano-synth 实时预览调试服务器
 *
 *  - demo/index.html 以虚拟根路径 "/" 提供(内部引用的 src/、model/ 直接从仓库根目录解析)
 *  - 监听 src/、model/、demo/ 的变化,通过 SSE 通知浏览器自动刷新
 *  - 零第三方依赖,直接运行:
 *      npm run dev [-- --port 8080 --open --host 0.0.0.0]
 */

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { exec } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DEMO_HTML = path.join(ROOT, "demo", "index.html");
const WATCH_DIRS = ["src", "model", "demo"];
const LIVERELOAD_PATH = "/__dev_reload";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mid": "audio/midi",
  ".midi": "audio/midi",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8"
};

const RELOAD_CLIENT_SCRIPT =
  '<script>\n' +
  '(function () {\n' +
  '  var es = new EventSource(' + JSON.stringify(LIVERELOAD_PATH) + ');\n' +
  '  es.addEventListener("reload", function () { location.reload(); });\n' +
  '  es.onerror = function () { es.close(); };\n' +
  '})();\n' +
  '</script>\n';

function parseArgs(argv) {
  const options = {
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT) || 3000,
    open: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--open" || arg === "-o") {
      options.open = true;
    } else if (arg === "--host") {
      options.host = next();
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--port" || arg === "-p") {
      options.port = Number(next());
    } else if (arg.startsWith("--port=")) {
      options.port = Number(arg.slice("--port=".length));
    } else if (arg.startsWith("-p=")) {
      options.port = Number(arg.slice("-p=".length));
    } else {
      console.warn(`[dev] 忽略未知参数: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    console.error("[dev] 无效端口: " + options.port);
    process.exit(1);
  }
  return options;
}

function printHelp() {
  console.log(`
pico-piano-synth 实时预览调试服务器

用法:
  npm run dev [-- <选项>]

选项:
  --port <n>   监听端口(默认 3000,可改用环境变量 PORT)
  --host <h>   监听地址(默认 127.0.0.1;局域网访问用 0.0.0.0)
  --open       启动后自动打开浏览器
  --help       显示帮助

说明:
  访问 http://localhost:3000/ 打开 demo 页。
  修改 src/、model/、demo/ 下的文件后浏览器会自动刷新。
`);
}

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function safeResolve(relativePath) {
  let resolved = path.normalize(path.join(ROOT, relativePath));
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

function injectReloadClient(html) {
  const marker = "</body>";
  const index = html.lastIndexOf(marker);
  if (index === -1) return html + RELOAD_CLIENT_SCRIPT;
  return html.slice(0, index) + RELOAD_CLIENT_SCRIPT + html.slice(index);
}

function sendText(res, status, body, headers) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, err.code === "ENOENT" ? 404 : 500, err.code === "ENOENT"
        ? "404 Not Found"
        : "500 Internal Server Error");
      return;
    }
    let body = data;
    const type = contentType(filePath);
    if (type.startsWith("text/html")) body = injectReloadClient(data.toString("utf8"));
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body)
    });
    res.end(body);
  });
}

function urlToFilePath(pathname) {
  // "/" 与 "/demo/..." 统一指向 demo 页;其余路径按仓库根目录解析,
  // 使 demo/index.html 里的 src/piano-synth.js、model/piano_nn.bin 相对引用直接可用。
  if (pathname === "/" || pathname === "/index.html") {
    return { filePath: DEMO_HTML, isVirtualDemo: true };
  }
  if (pathname === "/demo" || pathname === "/demo/") {
    return { filePath: DEMO_HTML, isVirtualDemo: true };
  }
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const filePath = safeResolve(relative);
  if (!filePath) return null;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    const index = path.join(filePath, "index.html");
    return fs.existsSync(index) ? { filePath: index, isVirtualDemo: false } : null;
  }
  return { filePath, isVirtualDemo: false };
}

function createServer() {
  const reloadClients = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === LIVERELOAD_PATH) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      });
      res.write(": connected\n\n");
      reloadClients.add(res);
      req.on("close", () => reloadClients.delete(res));
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "405 Method Not Allowed");
      return;
    }

    let target = null;
    try {
      target = urlToFilePath(url.pathname);
    } catch (err) {
      sendText(res, 400, "400 Bad Request");
      return;
    }

    if (!target || !fs.existsSync(target.filePath)) {
      if (!target) {
        sendText(res, 403, "403 Forbidden");
      } else {
        sendText(res, 404, `404 Not Found: ${url.pathname}`);
      }
      return;
    }

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Type": contentType(target.filePath),
        "Cache-Control": "no-store"
      });
      res.end();
      return;
    }

    serveStatic(res, target.filePath);
  });

  function broadcastReload(changed) {
    const payload = `event: reload\ndata: ${JSON.stringify(changed)}\n\n`;
    for (const client of reloadClients) client.write(payload);
  }

  return { server, broadcastReload, reloadClients };
}

function watchSources(onChange) {
  const watchers = [];
  for (const name of WATCH_DIRS) {
    const dir = path.join(ROOT, name);
    if (!fs.existsSync(dir)) continue;
    try {
      // Windows/macOS 下 fs.watch 支持递归;失败时退回非递归(本仓库目录均为扁平结构)。
      const watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
        const file = filename ? String(filename) : null;
        onChange({ dir: name, event, file });
      });
      watchers.push(watcher);
    } catch (err) {
      const watcher = fs.watch(dir, (event, filename) => {
        const file = filename ? String(filename) : null;
        onChange({ dir: name, event, file });
      });
      watchers.push(watcher);
    }
  }
  return watchers;
}

function openBrowser(url) {
  const platform = os.platform();
  const command =
    platform === "win32" ? `start "" "${url}"`
    : platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(command, () => {});
}

function printUrls(host, port) {
  const origins = new Set();
  if (host === "0.0.0.0" || host === "::") {
    for (const info of Object.values(os.networkInterfaces())) {
      for (const addr of info || []) {
        if (addr.family === "IPv4" && !addr.internal) {
          origins.add(`http://${addr.address}:${port}`);
        }
      }
    }
  } else {
    origins.add(`http://${host}:${port}`);
  }
  return [...origins];
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { server, broadcastReload } = createServer();

  let pendingTimer = null;
  let lastChange = "";
  watchSources(({ dir, event, file }) => {
    const label = file ? `${dir}/${file}` : dir;
    lastChange = label;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      console.log(`[dev] 检测到变更 ${lastChange} → 通知浏览器刷新`);
      broadcastReload(lastChange);
    }, 80);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[dev] 端口 ${options.port} 已被占用,换一个端口重试:`);
      console.error(`[dev]   npm run dev -- --port ${options.port + 1}`);
    } else {
      console.error("[dev] 服务器错误:", err.message);
    }
    process.exit(1);
  });

  server.listen(options.port, options.host, () => {
    const urls = printUrls(options.host, options.port);
    console.log("");
    console.log("pico-piano-synth 实时预览调试服务器已启动");
    urls.forEach((url) => console.log(`  打开 ${url}/`));
    console.log(`  监听变更: ${WATCH_DIRS.join(", ")}/`);
    console.log("  按 Ctrl+C 停止");
    console.log("");
    if (options.open && urls.length) openBrowser(urls[0] + "/");
  });
}

main();
