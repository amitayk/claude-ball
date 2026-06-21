import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT ?? 5180);
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  const file = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  try {
    const buf = await readFile(join(dir, file));
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}).listen(port, () => console.log(`\n  arena web app on http://localhost:${port}\n`));
