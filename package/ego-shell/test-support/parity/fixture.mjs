import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { CANVAS_ROUND_TRIPS } from "../canvas-round-trip.mjs";
import { pageHtml } from "./layout.mjs";

/**
 * Two loopback servers, so the iframe is cross-origin. Each logs the request
 * headers it receives, which a site sees as plainly as any page API.
 */
export async function startFixture() {
  const observer =
    `window.__canvasRoundTrip = () => ${CANVAS_ROUND_TRIPS};\n` +
    (await readFile(new URL("./observer.js", import.meta.url), "utf8"));
  let requests = [];
  const origins = {};
  const serve = (frame) =>
    createServer((request, response) => {
      const { pathname } = new URL(request.url, "http://127.0.0.1");
      const names = [];
      for (let i = 0; i < request.rawHeaders.length; i += 2) names.push(request.rawHeaders[i]);
      const headers = { ...request.headers };
      delete headers.host;
      requests.push({ frame, path: pathname, headerOrder: names.filter((name) => name.toLowerCase() !== "host"), headers });
      if (pathname === "/observer.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        response.end(observer);
        return;
      }
      if (pathname !== "/") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(pageHtml({ frame, iframeSrc: `${origins.iframe}/` }));
    });
  const servers = [];
  for (const frame of ["main", "iframe"]) {
    const server = serve(frame);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origins[frame] = `http://127.0.0.1:${server.address().port}`;
    servers.push(server);
  }
  return {
    url: `${origins.main}/`,
    origins,
    /** Requests since the last call, keyed so two runs line up. */
    takeRequests() {
      const taken = requests;
      requests = [];
      const keyed = {};
      for (const { frame, path, ...rest } of taken) {
        const key = `${frame} ${path}`;
        keyed[key] = keyed[key] ?? [];
        keyed[key].push(rest);
      }
      return keyed;
    },
    close: () => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))),
  };
}
