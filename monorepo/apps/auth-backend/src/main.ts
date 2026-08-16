import "dotenv/config";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { startDirectServers } from "@idnest/server-runtime";
import express from "express";
import { getPort, validateAuthRuntimeConfiguration } from "./app/config";
import { createOrchestratorRouter } from "./app/orchestrator";
import { createPagesRouter } from "./app/pages";
import { startAuthTransactionMaintenance } from "./app/transaction-maintenance";

const AUTH_FRONTEND_DIST_DIR = process.env.AUTH_FRONTEND_DIST_DIR ?? "public/auth";

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

  const kratosOrigin = (() => {
    try {
      return new URL(process.env.KRATOS_PUBLIC_URL ?? "").origin;
    } catch {
      return "";
    }
  })();
  const assetOrigins = (process.env.AUTH_ASSET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const contentSecurityPolicy = [
    "default-src 'self'",
    `connect-src 'self'${kratosOrigin ? ` ${kratosOrigin}` : ""}`,
    `img-src 'self' data:${assetOrigins.length ? ` ${assetOrigins.join(" ")}` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    `form-action 'self'${kratosOrigin ? ` ${kratosOrigin}` : ""}`,
  ].join("; ");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
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
  app.use(express.json({ limit: "64kb" }));
  app.use(express.urlencoded({ extended: false }));

  // Trusted Hydra/Kratos orchestration and browser-safe context APIs.
  app.use("/", createOrchestratorRouter());

  // Server-rendered auth pages (login / consent / logout / error). These are
  // same-origin navigations plus full-page form POSTs.
  app.use("/", createPagesRouter());

  const frontendRoot = resolve(AUTH_FRONTEND_DIST_DIR);
  const frontendIndex = resolve(frontendRoot, "index.html");
  if (existsSync(frontendIndex)) {
    app.use(
      "/auth",
      express.static(frontendRoot, {
        fallthrough: true,
        index: false,
        setHeaders: configureStaticCaching,
      }),
    );
    app.get(/^\/auth(?:\/.*)?$/, (req, res, next) => {
      if (req.path === "/auth/v1" || req.path.startsWith("/auth/v1/")) {
        next();
        return;
      }
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.sendFile(frontendIndex);
    });
  }

  return app;
}

const port = getPort();
validateAuthRuntimeConfiguration();
startAuthTransactionMaintenance();
startDirectServers({
  app: createServer(),
  port,
  label: "auth-backend",
  httpsEnabledVariable: "AUTH_HTTPS_ENABLED",
});
