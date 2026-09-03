import { Router, type NextFunction, type Request, type Response } from "express";
import { getAdminCsrfSecret } from "./config";
import { completeAdminLogin, logoutAdmin, startAdminLogin } from "./auth/bff";
import { createCsrfToken, requireAdminCsrf } from "./auth/csrf";
import { requireAdmin, type AuthedRequest } from "./auth/middleware";
import {
  archiveBrandConfiguration,
  archiveDelegationActorPolicyConfiguration,
  archiveDelegationResourceConfiguration,
  archivePolicyConfiguration,
  createBrandConfiguration,
  createClient,
  createDelegationResourceConfiguration,
  createPolicyConfiguration,
  deactivateIdentity,
  deleteClient,
  deleteClientAuthConfiguration,
  deleteIdentity,
  grantIdentityClientAccess,
  getBrandConfiguration,
  getClient,
  getClientAuthConfiguration,
  getIdentity,
  getDelegationResourceConfiguration,
  getPolicyConfiguration,
  listBrandConfigurations,
  listBrandConfigurationHistory,
  listClientAuthConfigurations,
  listClientAuthConfigurationHistory,
  listClientIdentityGrants,
  listClients,
  listDelegationActorPolicyConfigurations,
  listDelegationAuditActivity,
  listDelegationGrantActivity,
  listDelegationResourceConfigurations,
  listDelegationResourceHistory,
  listIdentities,
  listIdentityClientGrants,
  listIdentitySessions,
  listPolicyConfigurations,
  listPolicyConfigurationHistory,
  putClientAuthConfiguration,
  putDelegationActorPolicyConfiguration,
  revokeIdentityClientAccess,
  revokeDelegationGrantAsAdministrator,
  revokeIdentitySessions,
  revokeSession,
  setAdminRole,
  updateClient,
  updateBrandConfiguration,
  updateDelegationResourceConfiguration,
  updatePolicyConfiguration,
  type HandlerResult,
} from "./handlers";

type Handler<T> = (input: T) => Promise<HandlerResult>;

/** Adapt a pure handler into an Express route, selecting its input from the request. */
function adapt<T>(handler: Handler<T>, select: (req: Request) => T) {
  return async (req: Request, res: Response): Promise<void> => {
    const result = await handler(select(req));
    res.status(result.status).json(result.body);
  };
}

const fromBody = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const idFromParams = (req: Request) => ({ id: req.params.id });
const actorFrom = (req: Request): string | null => {
  const authed = req as AuthedRequest;
  return authed.adminIdentity?.id ?? authed.adminEmail ?? null;
};

function configurationRateLimit(req: Request, res: Response, next: NextFunction): void {
  const windowMs = 60_000;
  const maximum = 60;
  const now = Date.now();
  const authed = req as AuthedRequest;
  const key = authed.adminSessionId ?? req.ip ?? "unknown";
  const existing = configurationBuckets.get(key);
  const bucket =
    !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : existing;
  bucket.count += 1;
  configurationBuckets.set(key, bucket);
  if (configurationBuckets.size > 2_000) {
    for (const [candidate, value] of configurationBuckets) {
      if (value.resetAt <= now) configurationBuckets.delete(candidate);
    }
  }
  if (bucket.count > maximum) {
    res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
    res.status(429).json({ error: "Too many authentication configuration changes" });
    return;
  }
  next();
}

const configurationBuckets = new Map<string, { count: number; resetAt: number }>();

/**
 * Admin API routes sit behind requireAdmin: every request must carry a valid
 * BFF session cookie and pass the authorization policy before any handler runs.
 */
export function createAdminRouter(): Router {
  const router = Router();

  router.get("/auth/login", startAdminLogin);
  router.get("/auth/callback", completeAdminLogin);

  router.use(requireAdmin());

  // --- Authorization probe (reaching here means requireAdmin passed) ---
  router.get("/me", (req: AuthedRequest, res: Response) => {
    res.json({
      email: req.adminEmail,
      role: req.adminRole,
      sessionId: req.adminSessionId,
      identity: req.adminIdentity,
      csrfToken:
        req.adminIdentity && req.adminEmail
          ? createCsrfToken(req.adminIdentity, req.adminEmail, getAdminCsrfSecret())
          : undefined,
    });
  });

  router.use(requireAdminCsrf());

  router.post("/auth/logout", logoutAdmin);

  // --- Identities ---
  router.get(
    "/identities",
    adapt(listIdentities, (req) => ({
      page_size: req.query.page_size ? Number(req.query.page_size) : undefined,
      page_token: typeof req.query.page_token === "string" ? req.query.page_token : undefined,
    })),
  );
  router.get("/identities/:id", adapt(getIdentity, idFromParams));
  router.delete("/identities/:id", adapt(deleteIdentity, idFromParams));
  router.post("/identities/:id/deactivate", adapt(deactivateIdentity, idFromParams));
  router.post(
    "/identities/:id/role",
    adapt(setAdminRole, (req) => ({ id: req.params.id, admin: fromBody(req).admin === true })),
  );
  router.get("/identities/:id/client-access", adapt(listIdentityClientGrants, idFromParams));
  router.post(
    "/identities/:id/client-access/:clientId",
    adapt(grantIdentityClientAccess, (req) => {
      const authed = req as AuthedRequest;
      return {
        id: req.params.id,
        client_id: req.params.clientId,
        role: typeof fromBody(req).role === "string" ? String(fromBody(req).role) : "user",
        granted_by: authed.adminIdentity?.id ?? authed.adminEmail ?? null,
      };
    }),
  );
  router.delete(
    "/identities/:id/client-access/:clientId",
    adapt(revokeIdentityClientAccess, (req) => {
      const authed = req as AuthedRequest;
      return {
        id: req.params.id,
        client_id: req.params.clientId,
        granted_by: authed.adminIdentity?.id ?? authed.adminEmail ?? null,
      };
    }),
  );

  // --- Sessions ---
  router.get("/identities/:id/sessions", adapt(listIdentitySessions, idFromParams));
  router.delete("/identities/:id/sessions", adapt(revokeIdentitySessions, idFromParams));
  router.delete(
    "/sessions/:sessionId",
    adapt(revokeSession, (req) => ({ session_id: req.params.sessionId })),
  );

  // --- OAuth clients ---
  router.get("/clients", adapt(listClients, () => ({})));
  router.get("/clients/:clientId", adapt(getClient, (req) => ({ client_id: req.params.clientId })));
  router.get(
    "/clients/:clientId/identities",
    adapt(listClientIdentityGrants, (req) => ({ client_id: req.params.clientId })),
  );
  router.post("/clients", adapt(createClient, (req) => ({ ...fromBody(req), actor: actorFrom(req) })));
  router.put(
    "/clients/:clientId",
    adapt(updateClient, (req) => ({ ...fromBody(req), client_id: req.params.clientId })),
  );
  router.delete(
    "/clients/:clientId",
    adapt(deleteClient, (req) => ({ client_id: req.params.clientId })),
  );

  // --- Authentication branding and authentication policies ---
  router.get("/auth-brands", adapt(listBrandConfigurations, () => ({})));
  router.get("/auth-brands/:id", adapt(getBrandConfiguration, idFromParams));
  router.get(
    "/auth-brands/:id/history",
    adapt(listBrandConfigurationHistory, (req) => ({ id: req.params.id })),
  );
  router.post(
    "/auth-brands",
    configurationRateLimit,
    adapt(createBrandConfiguration, (req) => ({ body: fromBody(req), actor: actorFrom(req) })),
  );
  router.patch(
    "/auth-brands/:id",
    configurationRateLimit,
    adapt(updateBrandConfiguration, (req) => ({
      id: req.params.id,
      body: fromBody(req),
      actor: actorFrom(req),
    })),
  );
  router.delete(
    "/auth-brands/:id",
    configurationRateLimit,
    adapt(archiveBrandConfiguration, (req) => ({
      id: req.params.id,
      actor: actorFrom(req),
    })),
  );

  router.get("/authentication-policies", adapt(listPolicyConfigurations, () => ({})));
  router.get("/authentication-policies/:id", adapt(getPolicyConfiguration, idFromParams));
  router.get(
    "/authentication-policies/:id/history",
    adapt(listPolicyConfigurationHistory, (req) => ({ id: req.params.id })),
  );
  router.post(
    "/authentication-policies",
    configurationRateLimit,
    adapt(createPolicyConfiguration, (req) => ({ body: fromBody(req), actor: actorFrom(req) })),
  );
  router.patch(
    "/authentication-policies/:id",
    configurationRateLimit,
    adapt(updatePolicyConfiguration, (req) => ({
      id: req.params.id,
      body: fromBody(req),
      actor: actorFrom(req),
    })),
  );
  router.delete(
    "/authentication-policies/:id",
    configurationRateLimit,
    adapt(archivePolicyConfiguration, (req) => ({
      id: req.params.id,
      actor: actorFrom(req),
    })),
  );

  router.get("/client-auth-configs", adapt(listClientAuthConfigurations, () => ({})));
  router.get(
    "/client-auth-configs/:clientId",
    adapt(getClientAuthConfiguration, (req) => ({ clientId: req.params.clientId })),
  );
  router.get(
    "/client-auth-configs/:clientId/history",
    adapt(listClientAuthConfigurationHistory, (req) => ({
      clientId: req.params.clientId,
    })),
  );
  router.put(
    "/client-auth-configs/:clientId",
    configurationRateLimit,
    adapt(putClientAuthConfiguration, (req) => ({
      clientId: req.params.clientId,
      body: fromBody(req),
      actor: actorFrom(req),
    })),
  );
  router.delete(
    "/client-auth-configs/:clientId",
    configurationRateLimit,
    adapt(deleteClientAuthConfiguration, (req) => ({
      clientId: req.params.clientId,
      actor: actorFrom(req),
    })),
  );

  // --- Generic delegated authorization ---
  router.get("/delegation/resources", adapt(listDelegationResourceConfigurations, () => ({})));
  router.get(
    "/delegation/resources/:id",
    adapt(getDelegationResourceConfiguration, idFromParams),
  );
  router.get(
    "/delegation/resources/:id/history",
    adapt(listDelegationResourceHistory, idFromParams),
  );
  router.post(
    "/delegation/resources",
    configurationRateLimit,
    adapt(createDelegationResourceConfiguration, (req) => ({
      body: fromBody(req),
      actor: actorFrom(req),
    })),
  );
  router.patch(
    "/delegation/resources/:id",
    configurationRateLimit,
    adapt(updateDelegationResourceConfiguration, (req) => ({
      id: req.params.id,
      body: fromBody(req),
      actor: actorFrom(req),
    })),
  );
  router.delete(
    "/delegation/resources/:id",
    configurationRateLimit,
    adapt(archiveDelegationResourceConfiguration, (req) => ({
      id: req.params.id,
      actor: actorFrom(req),
    })),
  );
  router.get(
    "/delegation/resources/:id/actors",
    adapt(listDelegationActorPolicyConfigurations, idFromParams),
  );
  router.put(
    "/delegation/resources/:id/actors/:clientId",
    configurationRateLimit,
    adapt(putDelegationActorPolicyConfiguration, (req) => ({
      id: req.params.id,
      clientId: req.params.clientId,
      body: fromBody(req),
      actor: actorFrom(req),
    })),
  );
  router.delete(
    "/delegation/resources/:id/actors/:clientId",
    configurationRateLimit,
    adapt(archiveDelegationActorPolicyConfiguration, (req) => ({
      id: req.params.id,
      clientId: req.params.clientId,
      actor: actorFrom(req),
    })),
  );
  router.get(
    "/delegation/grants",
    adapt(listDelegationGrantActivity, (req) => ({
      resourceId: typeof req.query.resource_id === "string" ? req.query.resource_id : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    })),
  );
  router.delete(
    "/delegation/grants/:grantId",
    configurationRateLimit,
    adapt(revokeDelegationGrantAsAdministrator, (req) => ({
      grantId: req.params.grantId,
      actor: actorFrom(req),
    })),
  );
  router.get(
    "/delegation/audit",
    adapt(listDelegationAuditActivity, (req) => ({
      resourceId: typeof req.query.resource_id === "string" ? req.query.resource_id : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    })),
  );

  return router;
}
