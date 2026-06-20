const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const MAX_PORT_ATTEMPTS = 20;
const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "app");
const CONTENT_DIR = path.join(ROOT, "content");
const BACKUP_DIR = path.join(ROOT, "backups");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

function send(res, status, body, contentType = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff"
  });
  if (Buffer.isBuffer(body)) {
    res.end(body);
    return;
  }
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function normalizeRelativePath(filePath) {
  const decoded = decodeURIComponent(filePath || "").replace(/\\/g, "/");
  const normalized = path.posix.normalize(decoded).replace(/^(\.\.\/)+/, "");
  if (!normalized || normalized === "." || path.isAbsolute(decoded)) {
    throw new Error("Invalid file path.");
  }
  const ext = path.extname(normalized).toLowerCase();
  if (ext !== ".html" && ext !== ".htm") {
    throw new Error("Only .html and .htm files can be edited.");
  }
  return normalized;
}

function resolveContentPath(filePath) {
  const relative = normalizeRelativePath(filePath);
  const absolute = path.resolve(CONTENT_DIR, relative);
  const contentRoot = path.resolve(CONTENT_DIR);
  if (absolute !== contentRoot && !absolute.startsWith(contentRoot + path.sep)) {
    throw new Error("File path is outside content directory.");
  }
  return { relative, absolute };
}

function etagFor(content) {
  return crypto.createHash("sha1").update(content).digest("hex");
}

async function ensureDirs() {
  await fs.mkdir(CONTENT_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });
}

async function walkHtml(dir, base = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(base, entry.name);
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkHtml(absolute, relative));
    } else if (entry.isFile() && /\.(html|htm)$/i.test(entry.name)) {
      const stat = await fs.stat(absolute);
      files.push({
        path: relative,
        name: entry.name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  }
  return files;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const relative = decodeURIComponent(requested).replace(/^\/+/, "");
  const absolute = path.resolve(APP_DIR, relative);
  const appRoot = path.resolve(APP_DIR);

  if (absolute !== appRoot && !absolute.startsWith(appRoot + path.sep)) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  try {
    const content = await fs.readFile(absolute);
    send(res, 200, content, MIME_TYPES[path.extname(absolute).toLowerCase()] || "application/octet-stream");
  } catch (error) {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

async function serveContentAsset(res, pathname) {
  const relative = decodeURIComponent(pathname.replace(/^\/content\/?/, "")).replace(/\\/g, "/");
  const absolute = path.resolve(CONTENT_DIR, relative);
  const contentRoot = path.resolve(CONTENT_DIR);

  if (absolute !== contentRoot && !absolute.startsWith(contentRoot + path.sep)) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  try {
    const content = await fs.readFile(absolute);
    send(res, 200, content, MIME_TYPES[path.extname(absolute).toLowerCase()] || "application/octet-stream");
  } catch (error) {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/files") {
    const files = await walkHtml(CONTENT_DIR);
    files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    send(res, 200, { files });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    const { relative, absolute } = resolveContentPath(url.searchParams.get("path"));
    const content = await fs.readFile(absolute, "utf8");
    const stat = await fs.stat(absolute);
    send(res, 200, {
      path: relative,
      content,
      etag: etagFor(content),
      modifiedAt: stat.mtime.toISOString()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/file") {
    const payload = JSON.parse(await readBody(req));
    const { relative, absolute } = resolveContentPath(payload.path);
    const nextContent = String(payload.content ?? "");
    const previous = await fs.readFile(absolute, "utf8");
    const currentEtag = etagFor(previous);

    if (payload.etag && payload.etag !== currentEtag && !payload.force) {
      send(res, 409, {
        error: "File changed on disk after you opened it.",
        currentEtag
      });
      return;
    }

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const backupName = `${relative.replace(/[\\/]/g, "__")}.${stamp}.html`;
    await fs.writeFile(path.join(BACKUP_DIR, backupName), previous, "utf8");
    await fs.writeFile(absolute, nextContent, "utf8");

    send(res, 200, {
      ok: true,
      etag: etagFor(nextContent),
      backup: backupName,
      modifiedAt: new Date().toISOString()
    });
    return;
  }

  send(res, 404, { error: "Unknown API endpoint." });
}

async function main() {
  await ensureDirs();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
      } else if (url.pathname.startsWith("/content/")) {
        await serveContentAsset(res, url.pathname);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (error) {
      send(res, 500, { error: error.message || "Unexpected server error." });
    }
  });

  await listenWithFallback(server, PORT);
}

function listenWithFallback(server, preferredPort) {
  return new Promise((resolve, reject) => {
    let port = preferredPort;
    let attempts = 0;

    const tryListen = () => {
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE" && attempts < MAX_PORT_ATTEMPTS) {
          attempts += 1;
          port += 1;
          server.close(tryListen);
          return;
        }
        reject(error);
      });

      server.listen(port, "0.0.0.0", () => {
        console.log(`Local HTML CMS is running at http://localhost:${port}`);
        console.log(`Network address: http://192.168.0.100:${port}`);
        if (port !== preferredPort) {
          console.log(`Port ${preferredPort} was busy, so ${port} was used instead.`);
        }
        console.log(`Edit files in: ${CONTENT_DIR}`);
        resolve();
      });
    };

    tryListen();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
