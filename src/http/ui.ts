import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { DomainError, notFound } from "../domain/errors";

/**
 * The mobile web client is plain HTML/CSS/JS with no bundler, matching the
 * project's "read the source" philosophy. Files live in `src/ui` and are served
 * from the API origin so the app and the API stay same-origin on one port.
 *
 * `tsc` only emits JavaScript, so the built tree and the development tree are
 * both probed for the asset directory.
 */
const uiDirectoryCandidates = [
  join(__dirname, "ui"),
  join(__dirname, "..", "ui"),
  join(__dirname, "..", "..", "src", "ui"),
];

/** Public path -> on-disk asset. Only these names are ever read from disk. */
const uiAssets: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/app/app.js": { file: "app.js", contentType: "application/javascript; charset=utf-8" },
  "/app/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  "/app/icon.svg": { file: "icon.svg", contentType: "image/svg+xml; charset=utf-8" },
  "/app/manifest.webmanifest": {
    file: "manifest.webmanifest",
    contentType: "application/manifest+json; charset=utf-8",
  },
};

export const isUiPath = (pathname: string): boolean =>
  Object.hasOwn(uiAssets, pathname) || pathname.startsWith("/app/");

let cachedDirectory: string | undefined;

function uiDirectory(): string {
  if (cachedDirectory) {
    return cachedDirectory;
  }
  const directory = uiDirectoryCandidates.find((candidate) =>
    existsSync(join(candidate, "index.html")),
  );
  if (!directory) {
    throw notFound("UI assets are missing; run `npm run build` or serve from the repo root");
  }
  cachedDirectory = directory;
  return directory;
}

const assetCache = new Map<string, { content: Buffer; mtimeMs: number }>();

/** Read an asset, re-reading only when the file changed to ease local edits. */
function readAsset(filename: string): Buffer {
  const path = join(uiDirectory(), filename);
  const mtimeMs = statSync(path).mtimeMs;
  const cached = assetCache.get(filename);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.content;
  }
  const content = readFileSync(path);
  assetCache.set(filename, { content, mtimeMs });
  return content;
}

/**
 * Writes a UI asset. `ui.ts` never touches the database, so a missing file is
 * reported as a 404 rather than a 500.
 */
export function serveUiAsset(response: ServerResponse, pathname: string): void {
  const asset = uiAssets[pathname];
  if (!asset) {
    throw notFound("app asset was not found");
  }
  let content: Buffer;
  try {
    content = readAsset(asset.file);
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw notFound("app asset was not found");
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", asset.contentType);
  // no-cache keeps a phone honest about updates while still allowing 304s.
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  // The client ships as separate files, so inline scripts and styles stay out.
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "manifest-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; " +
      "frame-ancestors 'none'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  if (asset.file === "index.html" || asset.file === "icon.svg") {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  }
  response.end(content);
}
