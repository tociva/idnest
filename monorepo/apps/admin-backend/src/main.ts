import "dotenv/config";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { startDirectServers } from "@idnest/server-runtime";
import { isAllowedOrigin } from "@idnest/shared-types";
import cors from "cors";
import express from "express";
import { getAdminCorsOrigins, getPort } from "./app/config";
import { createAdminRouter } from "./app/routes";

const ADMIN_FRONTEND_DIST_DIR = process.env.ADMIN_FRONTEND_DIST_DIR ?? "public/admin";

function configureStaticCaching(res: express.Response, filePath: string): void {
  if (basename(filePath) === "index.html") {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    return;
  }
  if (/[-.][A-Z0-9]{8,}\.(?:css|js|mjs|woff2?)$/i.test(filePath)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=300");
}

export function createServer() {
  const app = express();
  const allowedOrigins = getAdminCorsOrigins();
  const assetOrigins = (process.env.AUTH_ASSET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const contentSecurityPolicy = [
    "default-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    `img-src 'self' data:${assetOrigins.length ? ` ${assetOrigins.join(" ")}` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  app.set("trust proxy", 1);

  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.set("X-Frame-Options", "DENY");
    res.set("Content-Security-Policy", contentSecurityPolicy);
    if (process.env.NODE_ENV === "production") {
      res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, origin === undefined || isAllowedOrigin(origin, allowedOrigins));
      },
      credentials: true,
    }),
  );
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/admin", createAdminRouter());
  app.get("/config/config.json", (_req, res) => {
    const apiBaseUrl = process.env.ADMIN_FRONTEND_API_BASE_URL?.trim() || "/api";
    const authLogoutUrl = process.env.ADMIN_FRONTEND_AUTH_LOGOUT_URL?.trim();
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.json({
      apiBaseUrl,
      ...(authLogoutUrl ? { authLogoutUrl } : {}),
    });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const frontendRoot = resolve(ADMIN_FRONTEND_DIST_DIR);
  const frontendIndex = resolve(frontendRoot, "index.html");
  if (existsSync(frontendIndex)) {
    app.use(
      express.static(frontendRoot, {
        fallthrough: true,
        index: false,
        setHeaders: configureStaticCaching,
      }),
    );
    app.get(/^(?!\/api(?:\/|$)|\/health$|\/config\/config\.json$).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.sendFile(frontendIndex);
    });
  }

  return app;
}

const port = getPort();
startDirectServers({
  app: createServer(),
  port,
  label: "admin-backend",
  httpsEnabledVariable: "ADMIN_HTTPS_ENABLED",
});
