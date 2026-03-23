/**
 * HTTP Proxy to Backend Services
 *
 * Forwards requests from the gateway to the appropriate backend
 * service and returns the response.
 */
import http from "http";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("gateway.proxy");

/** Max response body size from backend (5 MB) */
const MAX_RESPONSE_BYTES = 5_242_880;

interface ProxyRequest {
  backend: string;  // e.g., "http://127.0.0.1:9000"
  path: string;     // e.g., "/analyze"
  method: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}

interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Proxy a request to a backend service */
export function proxyRequest(req: ProxyRequest): Promise<ProxyResponse> {
  return new Promise((resolve) => {
    const timeout = req.timeoutMs ?? 30_000;

    try {
      const url = new URL(req.path, req.backend);

      const proxyReq = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: req.method,
          headers: {
            ...req.headers,
            host: url.host,
          },
          timeout,
        },
        (proxyRes) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          proxyRes.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              proxyReq.destroy();
              resolve({
                status: 502,
                headers: {},
                body: JSON.stringify({ error: "Backend response too large" }),
              });
              return;
            }
            chunks.push(chunk);
          });
          proxyRes.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const headers: Record<string, string> = {};
            for (const [key, val] of Object.entries(proxyRes.headers)) {
              if (typeof val === "string") headers[key] = val;
            }
            resolve({
              status: proxyRes.statusCode ?? 500,
              headers,
              body,
            });
          });
        },
      );

      proxyReq.on("error", () => {
        resolve({
          status: 503,
          headers: {},
          body: JSON.stringify({ error: "Backend unreachable" }),
        });
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        resolve({
          status: 504,
          headers: {},
          body: JSON.stringify({ error: "Backend timeout" }),
        });
      });

      if (req.body) {
        proxyReq.write(req.body);
      }
      proxyReq.end();
    } catch (err: unknown) {
      logger.error("Backend proxy request failed", { error: err instanceof Error ? err.message : String(err) });
      resolve({
        status: 503,
        headers: {},
        body: JSON.stringify({ error: "Backend unreachable" }),
      });
    }
  });
}
