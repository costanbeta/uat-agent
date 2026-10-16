import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Fixture {
  origin: string;
  received: { method: string; path: string }[];
  state: { fixed: boolean };
  close(): Promise<void>;
}

const page = (body: string, fixed = false) => `<!doctype html><html><head><title>Fixture</title><style>
body{font-family:sans-serif;margin:24px}
#badge{display:inline-block;padding:4px 8px;background:#eef;${fixed ? "border:1px solid #333;" : ""}}
button{margin-left:8px}
</style></head><body>${body}</body></html>`;

export async function startFixture(): Promise<Fixture> {
  const received: Fixture["received"] = [];
  const state = { fixed: false };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (code: number, html: string, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "text/html", ...headers });
      res.end(html);
    };
    if (url.pathname.startsWith("/api/")) {
      received.push({ method: req.method ?? "", path: url.pathname });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    switch (url.pathname) {
      case "/app":
        return send(
          200,
          page(
            `<h1 id="title">Templates</h1><span id="badge">Active</span>
<button id="trash" aria-label="trash">x</button><button id="del">Delete</button>
<div id="app-ready">ready</div>
<script>
document.getElementById('trash').onclick=()=>fetch('/api/delete',{method:'DELETE'});
if(location.search.includes('writes')){
 fetch('/api/x',{method:'patch'});fetch('/api/x',{method:'PUT'});fetch('/api/x',{method:'DELETE'});
 fetch('/api/delete',{method:'POST',body:'{}'});fetch('/api/search',{method:'POST',body:'{}'});
 fetch('/api/override',{method:'POST',headers:{'X-HTTP-Method-Override':'DELETE'}});
}
</script>`,
            state.fixed,
          ),
        );
      case "/expired":
        return send(302, "", { location: "/login" });
      case "/login":
        return send(200, page(`<form><input type="password" name="p"><div id="app-ready">login</div></form>`));
      case "/gone":
        return send(404, page(`<div id="app-ready">not found</div>`));
      case "/nolandmark":
        return send(200, page(`<h1>No landmark here</h1>`));
      case "/pw":
        return send(200, page(`<div id="app-ready">settings</div><input type="password" name="apikey">`));
      default:
        return send(404, "nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
