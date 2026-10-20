import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// For `npm run dev` without the app: stands in for the app's graphics
// commands and local server, keeping the project's graphics in
// public/fixtures/graphics (not committed).
export function devGraphics() {
  const bundled = join(__dirname, "graphics");
  const project = join(__dirname, "public/fixtures/graphics");
  return {
    name: "roughcut-dev-graphics",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/dev-graphics", (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const send = (body, type = "text/plain") => {
          res.setHeader("Content-Type", type);
          res.end(body);
        };
        if (url.pathname === "/add") {
          const name = url.searchParams.get("name") ?? "";
          let slug = name;
          for (let n = 2; existsSync(join(project, slug)); n++) slug = `${name}-${n}`;
          cpSync(join(bundled, name), join(project, slug), { recursive: true });
          renameSync(join(project, slug, "index.html"), join(project, slug, "source.html"));
          cpSync(join(project, slug, "source.html"), join(project, slug, "index.html"));
          if (!existsSync(join(project, "lib"))) cpSync(join(bundled, "lib"), join(project, "lib"), { recursive: true });
          return send(slug);
        }
        if (url.pathname === "/view" && req.method === "POST") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            mkdirSync(join(project, url.searchParams.get("slug")), { recursive: true });
            writeFileSync(join(project, url.searchParams.get("slug"), "index.html"), body);
            send("ok");
          });
          return;
        }
        if (url.pathname === "/bridge.js") return send(readFileSync(join(__dirname, "src-tauri/src/graphics-bridge.js")), "text/javascript");
        const file = join(project, decodeURIComponent(url.pathname));
        if (!file.startsWith(project) || !existsSync(file)) {
          res.statusCode = 404;
          return res.end();
        }
        if (url.searchParams.has("preview") && file.endsWith(".html")) {
          const tags = '<script src="../lib/hyperframes-runtime.js" data-hyperframes-preview-runtime></script>\n<script src="/dev-graphics/bridge.js"></script>\n';
          return send(readFileSync(file, "utf8").replace("</head>", `${tags}</head>`), "text/html");
        }
        const types = { js: "text/javascript", html: "text/html", css: "text/css", woff2: "font/woff2", jpg: "image/jpeg", svg: "image/svg+xml", png: "image/png" };
        send(readFileSync(file), types[file.split(".").pop()] ?? "application/octet-stream");
      });
      server.middlewares.use("/dev-catalog", (req, res) => {
        const file = join(bundled, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
        if (!file.startsWith(bundled) || !existsSync(file)) {
          res.statusCode = 404;
          return res.end();
        }
        res.end(readFileSync(file));
      });
    },
  };
}

