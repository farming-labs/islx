// A plain Node server: Vite's middleware in development, the build in production.
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT ?? 4300);

let handle;
let vite;
if (dev) {
  const { createServer } = await import("vite");
  vite = await createServer({ root, server: { middlewareMode: true }, appType: "custom" });
  handle = async (request) => (await vite.environments.ssr.runner.import("/src/entry-server.tsx")).handle(request);
} else {
  ({ handle } = await import("./dist/server/entry-server.js"));
}

function toRequest(req) {
  const url = `http://${req.headers.host}${req.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
    else if (value !== undefined) headers.set(key, value);
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : req;
  return new Request(url, { method: req.method, headers, body, duplex: "half" });
}

async function send(response, res) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) return res.end();
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

const types = { ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

const server = http.createServer(async (req, res) => {
  try {
    if (!dev && req.url.startsWith("/assets/")) {
      const file = path.join(root, "dist/client", req.url.split("?")[0]);
      if (existsSync(file) && statSync(file).isFile()) {
        res.setHeader("content-type", types[path.extname(file)] ?? "application/octet-stream");
        return createReadStream(file).pipe(res);
      }
    }
    const run = () => handle(toRequest(req)).then((response) => send(response, res));
    if (vite) vite.middlewares(req, res, run);
    else await run();
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.end("Internal Server Error");
  }
});
server.listen(port, () => console.log(`listening on http://localhost:${port}`));
