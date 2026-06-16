import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT ?? 5173);

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
};

const server = createServer(async (req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0]!;
  const file = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  try {
    const buf = await readFile(join(dir, file));
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found. Did you generate replay.json? Try: npm run demo");
  }
});

server.listen(port, () => {
  console.log(`\n  viewer running at http://localhost:${port}\n`);
});
