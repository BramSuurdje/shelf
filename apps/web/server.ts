import { existsSync } from "node:fs"
import { extname, join, normalize } from "node:path"

const root = join(import.meta.dir, "dist")
const port = Number(Bun.env.WEB_PORT ?? 5173)
const apiBaseUrl = Bun.env.API_PROXY_URL ?? "http://api:8787"

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
}

function staticPath(pathname: string) {
  const requested = pathname === "/" ? "/index.html" : pathname
  const decoded = decodeURIComponent(requested)
  const normalized = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "")
  return join(root, normalized)
}

async function serveStatic(pathname: string) {
  const filePath = staticPath(pathname)
  const resolvedPath = existsSync(filePath) ? filePath : join(root, "index.html")
  const file = Bun.file(resolvedPath)
  const extension = extname(resolvedPath)
  return new Response(file, {
    headers: {
      "cache-control":
        resolvedPath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      "content-type": contentTypes[extension] ?? "application/octet-stream",
    },
  })
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/healthz") || url.pathname.startsWith("/readyz")) {
      const upstream = new URL(url.pathname + url.search, apiBaseUrl)
      try {
        return await fetch(upstream, request)
      } catch {
        return Response.json(
          { error: { message: "Shelf API is unavailable" } },
          { status: 502 }
        )
      }
    }
    return serveStatic(url.pathname)
  },
})

console.log(`Shelf web server listening on ${port}`)
