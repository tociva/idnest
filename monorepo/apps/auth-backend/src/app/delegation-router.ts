import { getAuthzPool, type Db } from "@idnest/authz-store";
import {
  DELEGATION_GRANT_TOKEN_TYPE,
  DELEGATION_GRANT_TYPE,
  OAUTH_ACCESS_TOKEN_TYPE,
  type DelegationGrantRequest,
} from "@idnest/shared-types";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool, PoolClient } from "pg";
import {
  getAuthBaseUrl,
  getAuthzDatabaseUrl,
  getDelegationBrokerAudience,
  getDelegationGrantTtlSeconds,
  getDelegationIssuer,
  isDelegationEnabled,
} from "./config";
import { introspectDelegationServiceToken } from "./delegation-hydra";
import {
  DelegationProtocolError,
  exchangeDelegationGrant,
  issueDelegationGrant,
  revokePendingDelegationGrant,
  type DelegationServiceDependencies,
} from "./delegation-service";
import { Es256DelegationTokenSigner } from "./delegation-token";

function database(): Pool {
  const pool = getAuthzPool(getAuthzDatabaseUrl());
  if (!pool) throw new Error("AUTHZ_DATABASE_URL is not configured");
  return pool;
}

async function transaction<T>(work: (db: Db) => Promise<T>): Promise<T> {
  const client: PoolClient = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function bearerToken(req: Request): string | null {
  const authorization = req.header("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function noStore(res: Response): void {
  res.set("Cache-Control", "no-store, max-age=0");
  res.set("Pragma", "no-cache");
}

function rateLimit(maximum: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const previous = buckets.get(key);
    const bucket = !previous || previous.resetAt <= now
      ? { count: 1, resetAt: now + windowMs }
      : { count: previous.count + 1, resetAt: previous.resetAt };
    buckets.set(key, bucket);
    if (buckets.size > 5_000) {
      for (const [candidate, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(candidate);
      }
    }
    res.set("RateLimit-Limit", String(maximum));
    res.set("RateLimit-Remaining", String(Math.max(0, maximum - bucket.count)));
    res.set("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > maximum) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    next();
  };
}

function serviceDependencies(signer: Es256DelegationTokenSigner): DelegationServiceDependencies {
  return {
    transaction,
    signer,
    brokerAudience: getDelegationBrokerAudience(),
    grantTtlSeconds: getDelegationGrantTtlSeconds(),
  };
}

function sendError(res: Response, error: unknown): void {
  noStore(res);
  if (error instanceof DelegationProtocolError) {
    if (error.status === 401) res.set("WWW-Authenticate", 'Bearer realm="delegation"');
    res.status(error.status).json({ error: error.error, error_description: error.message });
    return;
  }
  console.error("Delegation broker request failed", error);
  res.status(503).json({
    error: "temporarily_unavailable",
    error_description: "Delegated authorization is temporarily unavailable",
  });
}

function enabled(_req: Request, res: Response, next: NextFunction): void {
  if (!isDelegationEnabled()) {
    noStore(res);
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}

export function createDelegationRouter(): Router {
  const router = Router();
  const signer = new Es256DelegationTokenSigner();
  const limited = rateLimit(120, 60_000);

  router.get("/.well-known/idnest-delegation-configuration", enabled, (_req, res) => {
    const api = `${getAuthBaseUrl()}/auth/v1/delegation`;
    res.json({
      issuer: getDelegationIssuer(),
      jwks_uri: `${api}/jwks`,
      grant_endpoint: `${api}/grants`,
      token_endpoint: `${api}/token`,
      grant_types_supported: [DELEGATION_GRANT_TYPE],
      subject_token_types_supported: [DELEGATION_GRANT_TOKEN_TYPE],
      actor_token_types_supported: [OAUTH_ACCESS_TOKEN_TYPE],
      token_endpoint_auth_methods_supported: ["actor_access_token"],
    });
  });

  router.get("/auth/v1/delegation/jwks", enabled, async (_req, res) => {
    try {
      res.set("Cache-Control", "public, max-age=300");
      res.json(await signer.jwks());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/auth/v1/delegation/grants", enabled, limited, async (req, res) => {
    noStore(res);
    try {
      const token = bearerToken(req);
      const principal = token ? await introspectDelegationServiceToken(token) : null;
      const result = await issueDelegationGrant(
        serviceDependencies(signer),
        principal,
        (req.body ?? {}) as DelegationGrantRequest,
      );
      res.status(201).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete("/auth/v1/delegation/grants/:grantId", enabled, limited, async (req, res) => {
    noStore(res);
    try {
      const token = bearerToken(req);
      const principal = token ? await introspectDelegationServiceToken(token) : null;
      await revokePendingDelegationGrant(
        serviceDependencies(signer),
        principal,
        String(req.params.grantId ?? ""),
      );
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/auth/v1/delegation/token", enabled, limited, async (req, res) => {
    noStore(res);
    try {
      if (
        req.body?.grant_type !== DELEGATION_GRANT_TYPE ||
        req.body?.subject_token_type !== DELEGATION_GRANT_TOKEN_TYPE ||
        req.body?.actor_token_type !== OAUTH_ACCESS_TOKEN_TYPE
      ) {
        throw new DelegationProtocolError(
          "unsupported_grant_type",
          400,
          "A supported token exchange grant and token types are required",
        );
      }
      const actorToken = typeof req.body.actor_token === "string" ? req.body.actor_token : "";
      const principal = actorToken
        ? await introspectDelegationServiceToken(actorToken)
        : null;
      const result = await exchangeDelegationGrant(serviceDependencies(signer), principal, {
        subjectToken: typeof req.body.subject_token === "string" ? req.body.subject_token : "",
        resource: typeof req.body.resource === "string" ? req.body.resource : undefined,
        scope: typeof req.body.scope === "string" ? req.body.scope : undefined,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
