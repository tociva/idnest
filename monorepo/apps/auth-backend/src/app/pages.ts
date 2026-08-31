/**
 * Server-rendered auth pages (login / consent / logout / error), replacing the
 * former Angular `auth-frontend` SPA. Each route does the Hydra/Kratos work
 * server-side and 302-redirects the browser; only `/login` and `/error` render
 * HTML. The privileged Hydra/Kratos admin work is reused from `./handlers`.
 */
import {
  isAllowedOrigin,
  publicAuthRecoveryForClient,
  type HydraClient,
  type PublicAuthRecovery,
} from "@idnest/shared-types";
import { Router, type Request, type Response } from "express";
import { getAuthBaseUrl, getReturnToOrigins } from "./config";
import { getHumanHint, pickSafeDetails } from "./error-utils";
import { acceptLogin, acceptLogout, rejectConsent } from "./handlers";
import { getHydraClient } from "./hydra-admin";
import {
  acceptLoadedConsent,
  auditDecision,
  decideConsent,
  rememberConsent,
} from "./handlers/consent-decision";
import { createConsentActionToken, verifyConsentActionToken } from "./handlers/consent-token";
import * as kratos from "./kratos-public";
import {
  permissionForScope,
  renderAccessDenied,
  renderConsent,
  renderError,
  renderLogin,
  renderPrivacy,
  renderSettings,
  renderTerms,
} from "./views";
import { getConsentActionSecret } from "./config";
import { applyAuthCsp, clientOriginsFromLoginFlow } from "./apply-form-action-csp";
import { clientRedirectOrigins } from "./form-action-csp";
import {
  factorSettingsNodesFromFlow,
  hiddenInputsFromFlow,
  messagesFromFlow,
  oidcSubmitButtonsFromFlow,
  type FlowHiddenInput,
} from "./views/pages/flow-controls";

function first(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * Allow post-login redirects only to known app origins plus the internal
 * settings handoff. This keeps session-only login `return_to` from becoming an
 * open redirect while still letting /settings require login first.
 */
function isRegisteredClientReturnTo(target: string, client: HydraClient): boolean {
  try {
    const normalizedTarget = new URL(target).toString();
    return (client.metadata?.allowed_return_uris ?? []).some((registered) => {
      try {
        return new URL(registered).toString() === normalizedTarget;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function isAllowedAppReturnTo(target: string, clientId?: string): Promise<boolean> {
  if (clientId) {
    try {
      if (isRegisteredClientReturnTo(target, await getHydraClient(clientId))) return true;
    } catch {
      // Fall through to the narrow deployment-level migration allowlist.
    }
  }
  return isAllowedOrigin(target, getReturnToOrigins());
}

function isAllowedAuthReturnTo(target: string): boolean {
  try {
    const url = new URL(target);
    const auth = new URL(getAuthBaseUrl());
    return url.origin === auth.origin && url.pathname === "/settings";
  } catch {
    return false;
  }
}

/** Product apps plus the trusted OAuth completion URL used after AAL2 enrollment. */
async function isAllowedSettingsReturnTo(target: string, clientId?: string): Promise<boolean> {
  if (await isAllowedAppReturnTo(target, clientId)) return true;
  try {
    const url = new URL(target);
    const auth = new URL(getAuthBaseUrl());
    return url.origin === auth.origin && url.pathname === "/oauth2/login/complete";
  } catch {
    return false;
  }
}

async function isAllowedReturnTo(target: string, clientId?: string): Promise<boolean> {
  return (await isAllowedAppReturnTo(target, clientId)) || isAllowedAuthReturnTo(target);
}

function settingsUrl(returnTo: string | undefined, clientId?: string): string {
  const params = new URLSearchParams();
  if (returnTo) params.set("return_to", returnTo);
  if (clientId) params.set("client_id", clientId);
  const query = params.toString();
  return `${getAuthBaseUrl()}/settings${query ? `?${query}` : ""}`;
}

function settingsReturnUrl(returnTo: string | undefined, clientId?: string): string {
  const params = new URLSearchParams();
  if (returnTo) params.set("return_to", returnTo);
  if (clientId) params.set("client_id", clientId);
  const query = params.toString();
  return `${getAuthBaseUrl()}/settings/return${query ? `?${query}` : ""}`;
}

function loginUrl(returnTo: string, clientId?: string): string {
  const params = new URLSearchParams({ return_to: returnTo });
  if (clientId) params.set("client_id", clientId);
  return `/login?${params.toString()}`;
}

function switchAccountUrl(client: HydraClient): string | undefined {
  if (!client.client_uri) return undefined;
  try {
    const clientRoot = new URL("/", client.client_uri).toString();
    if (!isRegisteredClientReturnTo(clientRoot, client)) return undefined;
    const params = new URLSearchParams({ return_to: clientRoot, client_id: client.client_id });
    return `/logout?${params.toString()}`;
  } catch {
    return undefined;
  }
}

function withExtraHiddenInput(inputs: FlowHiddenInput[], name: string, value: string | undefined): FlowHiddenInput[] {
  return value ? [...inputs, { name, value }] : inputs;
}

function bodyString(req: Request, name: string): string | undefined {
  const value = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : undefined;
}

function identityEmail(identity: { traits?: Record<string, unknown> }): string {
  const email = identity.traits?.["email"];
  return typeof email === "string" ? email : "";
}

function clientDomain(clientUri: string | undefined): string | undefined {
  if (!clientUri) return undefined;
  try {
    return new URL(clientUri).host;
  } catch {
    return undefined;
  }
}

function clientRecovery(
  client: HydraClient | undefined,
  clientId: string | undefined,
): PublicAuthRecovery {
  if (!client && !clientId) return { kind: "request_context_unavailable" };
  return publicAuthRecoveryForClient(
    {
      hydraClientId: client?.client_id ?? clientId ?? "unknown-client",
      clientDisplayName: client?.client_name ?? clientId,
      clientHomeUrl: client?.client_uri,
    },
    client?.client_name ?? clientId ?? "the application",
  );
}

/** Render the error page from an arbitrary error payload. */
function sendError(
  res: Response,
  payload: unknown,
  status = 400,
  recovery: PublicAuthRecovery = { kind: "request_context_unavailable" },
): void {
  res.status(status).type("html").send(
    renderError({ safeDetails: pickSafeDetails(payload), hint: getHumanHint(payload), recovery }),
  );
}

export function createPagesRouter(): Router {
  const router = Router();

  router.get("/privacy", (_req: Request, res: Response): void => {
    res.type("html").send(renderPrivacy());
  });

  router.get("/terms", (_req: Request, res: Response): void => {
    res.type("html").send(renderTerms());
  });

  /**
   * GET /login
   *  - No `flow`: start the Kratos browser login flow, telling it to send the
   *    browser back to /login/return (carrying the login_challenge) after login.
   *  - `flow` present: Kratos has bounced the browser here with a flow id; load
   *    it server-side, read the csrf_token, and render provider buttons.
   */
  router.get("/login", async (req: Request, res: Response): Promise<void> => {
    const flow = first(req.query["flow"]);
    const loginChallenge = first(req.query["login_challenge"]);
    const loginHint = first(req.query["login_hint"]);
    const clientId = first(req.query["client_id"]);

    if (!flow) {
      // Carry both the Hydra `login_challenge` (OAuth flow) and a session-only
      // `return_to` (e.g. the admin console) through Kratos, so /login/return
      // can tell the two cases apart afterwards.
      const postLoginReturnTo = first(req.query["return_to"]);
      const params = new URLSearchParams();
      if (loginChallenge) params.set("login_challenge", loginChallenge);
      if (postLoginReturnTo) params.set("return_to", postLoginReturnTo);
      if (clientId) params.set("client_id", clientId);
      const query = params.toString();
      const returnTo = `${getAuthBaseUrl()}/login/return${query ? `?${query}` : ""}`;
      res.redirect(kratos.browserLoginUrl(returnTo));
      return;
    }

    try {
      const flowData = await kratos.getLoginFlow(flow, req);
      // Use the flow's own `ui.action` (Kratos builds it from its public
      // base_url, so it's always the correct browser-reachable submit URL)
      // rather than reconstructing it from KRATOS_PUBLIC_URL.
      applyAuthCsp(res, await clientOriginsFromLoginFlow(flowData));
      res.type("html").send(
        renderLogin({
          actionUrl: flowData.ui.action,
          hiddenInputs: withExtraHiddenInput(hiddenInputsFromFlow(flowData), "login_hint", loginHint),
          providers: oidcSubmitButtonsFromFlow(flowData, "Continue with"),
          messages: messagesFromFlow(flowData),
        }),
      );
    } catch (err) {
      console.error("Failed to load Kratos login flow", err);
      sendError(
        res,
        { error: "login_flow_error", error_description: "Could not load the login flow. Please try again." },
        502,
      );
    }
  });

  /**
   * GET /login/return — Kratos redirects here after a successful social login.
   * Resolve the identity (forwarding the session cookie), then accept the Hydra
   * login challenge and redirect on to Hydra. Replaces the SPA's whoami polling.
   */
  router.get("/login/return", async (req: Request, res: Response): Promise<void> => {
    const loginChallenge = first(req.query["login_challenge"]);

    // Session-only login (e.g. the admin console authenticates on the Kratos
    // session cookie, not a Hydra challenge). Kratos has already set the
    // session, so send the browser back to the app's return_to — validated
    // against the origin allowlist to prevent an open redirect.
    if (!loginChallenge) {
      const returnTo = first(req.query["return_to"]);
      const clientId = first(req.query["client_id"]);
      if (returnTo && await isAllowedReturnTo(returnTo, clientId)) {
        res.redirect(returnTo);
        return;
      }
      sendError(res, { error: "missing_login_challenge", error_description: "Missing login_challenge." });
      return;
    }

    try {
      const { identity } = await kratos.whoamiWithRetry(req);
      const result = await acceptLogin({
        login_challenge: loginChallenge,
        subject: identity.id,
      });
      const redirectTo = (result.body as { redirect_to?: string }).redirect_to;
      if (result.status === 200 && redirectTo) {
        res.redirect(redirectTo);
        return;
      }
      sendError(res, result.body, result.status);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401) {
        sendError(
          res,
          {
            error: "login_unconfirmed",
            error_description: "We couldn't confirm your login. Please try signing in again.",
          },
          401,
        );
        return;
      }
      sendError(
        res,
        { error: "login_return_error", error_description: e instanceof Error ? e.message : "Session error" },
        500,
      );
    }
  });

  /**
   * GET /settings
   *  - No `flow`: require a Kratos session, then start the browser settings flow.
   *  - `flow` present: load the flow and render OIDC link/unlink controls.
   */
  router.get("/settings", async (req: Request, res: Response): Promise<void> => {
    const flow = first(req.query["flow"]);
    const returnTo = first(req.query["return_to"]);
    const clientId = first(req.query["client_id"]);

    if (returnTo && !(await isAllowedSettingsReturnTo(returnTo, clientId))) {
      sendError(
        res,
        {
          error: "invalid_return_to",
          error_description: "The settings return_to URL is not allowed.",
        },
        400,
      );
      return;
    }

    if (!flow) {
      try {
        await kratos.whoami(req);
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 401) {
          res.redirect(loginUrl(settingsUrl(returnTo, clientId), clientId));
          return;
        }
        sendError(
          res,
          { error: "settings_session_error", error_description: e instanceof Error ? e.message : "Session error" },
          500,
        );
        return;
      }

      res.redirect(kratos.browserSettingsUrl(settingsReturnUrl(returnTo, clientId)));
      return;
    }

    try {
      const flowData = await kratos.getSettingsFlow(flow, req);
      res.type("html").send(
        renderSettings({
          actionUrl: flowData.ui.action,
          hiddenInputs: hiddenInputsFromFlow(flowData),
          providers: oidcSubmitButtonsFromFlow(flowData, "Link"),
          factorNodes: factorSettingsNodesFromFlow(flowData),
          returnTo,
          messages: messagesFromFlow(flowData),
        }),
      );
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401) {
        res.redirect(loginUrl(settingsUrl(returnTo, clientId), clientId));
        return;
      }
      sendError(
        res,
        { error: "settings_flow_error", error_description: e instanceof Error ? e.message : "Settings error" },
        500,
      );
    }
  });

  /**
   * GET /settings/return — Kratos sends the browser here after a successful
   * settings operation. Redirect back to the originating product app.
   */
  router.get("/settings/return", async (req: Request, res: Response): Promise<void> => {
    const returnTo = first(req.query["return_to"]);
    const clientId = first(req.query["client_id"]);
    if (returnTo && await isAllowedSettingsReturnTo(returnTo, clientId)) {
      res.redirect(returnTo);
      return;
    }

    if (returnTo) {
      sendError(
        res,
        {
          error: "invalid_return_to",
          error_description: "The settings return_to URL is not allowed.",
        },
        400,
      );
      return;
    }

    res.redirect("/settings");
  });

  /** GET /consent — risk-based Hydra consent screen. */
  router.get("/consent", async (req: Request, res: Response): Promise<void> => {
    const consentChallenge = first(req.query["consent_challenge"]);
    if (!consentChallenge) {
      sendError(res, { error: "missing_consent_challenge", error_description: "No consent_challenge provided." });
      return;
    }

    try {
      const decision = await decideConsent(consentChallenge);
      const { loaded } = decision;
      if (!decision.hasAccess) {
        res.status(403).type("html").send(
          renderAccessDenied({
            clientName: loaded.client.client_name ?? loaded.clientId,
            email: identityEmail(loaded.identity),
            reason: "This account is not allowed to use this application.",
            switchAccountUrl: switchAccountUrl(loaded.client),
            recovery: clientRecovery(loaded.client, loaded.clientId),
          }),
        );
        return;
      }

      if (decision.canAutoAccept) {
        await auditDecision(loaded, "auto_accept", decision.autoAcceptReason);
        const result = await acceptLoadedConsent(loaded);
        const redirectTo = (result.body as { redirect_to?: string }).redirect_to;
        if (result.status === 200 && redirectTo) {
          res.redirect(redirectTo);
          return;
        }
        sendError(res, result.body, result.status);
        return;
      }

      await auditDecision(loaded, "prompt", decision.reasons.join(","));
      const secret = getConsentActionSecret();
      applyAuthCsp(res, clientRedirectOrigins(loaded.client.redirect_uris));
      res.type("html").send(
        renderConsent({
          clientName: loaded.client.client_name ?? loaded.clientId,
          clientDomain: clientDomain(loaded.client.client_uri),
          logoUri: loaded.client.logo_uri,
          policyUri: loaded.client.policy_uri,
          tosUri: loaded.client.tos_uri,
          email: identityEmail(loaded.identity),
          trustTier: loaded.trustTier,
          permissions: loaded.scopes.map(permissionForScope),
          consentChallenge,
          acceptToken: createConsentActionToken(
            { action: "accept", challenge: loaded.challenge, subject: loaded.subject, client_id: loaded.clientId },
            secret,
          ),
          rejectToken: createConsentActionToken(
            { action: "reject", challenge: loaded.challenge, subject: loaded.subject, client_id: loaded.clientId },
            secret,
          ),
          reason: decision.observeOnly && decision.reasons.includes("missing_client_access_grant")
            ? "Access is not granted yet; observe mode is allowing this request while grants are migrated."
            : undefined,
        }),
      );
    } catch (e) {
      sendError(res, { error: "consent_error", error_description: e instanceof Error ? e.message : "Consent error" }, 500);
    }
  });

  router.post("/consent/accept", async (req: Request, res: Response): Promise<void> => {
    const consentChallenge = bodyString(req, "consent_challenge");
    const token = bodyString(req, "token");
    if (!consentChallenge || !token) {
      sendError(res, { error: "invalid_consent_action", error_description: "Missing consent action token." }, 400);
      return;
    }

    try {
      const decision = await decideConsent(consentChallenge);
      const { loaded } = decision;
      const valid = verifyConsentActionToken(
        token,
        getConsentActionSecret(),
        { action: "accept", challenge: loaded.challenge, subject: loaded.subject, client_id: loaded.clientId },
      );
      if (!valid) {
        sendError(res, { error: "invalid_consent_action", error_description: "Consent action expired or changed." }, 400);
        return;
      }
      if (!decision.hasAccess) {
        res.status(403).type("html").send(
          renderAccessDenied({
            clientName: loaded.client.client_name ?? loaded.clientId,
            email: identityEmail(loaded.identity),
            reason: "This account is not allowed to use this application.",
            switchAccountUrl: switchAccountUrl(loaded.client),
            recovery: clientRecovery(loaded.client, loaded.clientId),
          }),
        );
        return;
      }
      await rememberConsent(loaded);
      await auditDecision(loaded, "accept", "interactive_consent");
      const result = await acceptLoadedConsent(loaded);
      const redirectTo = (result.body as { redirect_to?: string }).redirect_to;
      if (result.status === 200 && redirectTo) {
        res.redirect(redirectTo);
        return;
      }
      sendError(res, result.body, result.status);
    } catch (e) {
      sendError(res, { error: "consent_error", error_description: e instanceof Error ? e.message : "Consent error" }, 500);
    }
  });

  router.post("/consent/reject", async (req: Request, res: Response): Promise<void> => {
    const consentChallenge = bodyString(req, "consent_challenge");
    const token = bodyString(req, "token");
    if (!consentChallenge || !token) {
      sendError(res, { error: "invalid_consent_action", error_description: "Missing consent action token." }, 400);
      return;
    }

    try {
      const decision = await decideConsent(consentChallenge);
      const { loaded } = decision;
      const valid = verifyConsentActionToken(
        token,
        getConsentActionSecret(),
        { action: "reject", challenge: loaded.challenge, subject: loaded.subject, client_id: loaded.clientId },
      );
      if (!valid) {
        sendError(res, { error: "invalid_consent_action", error_description: "Consent action expired or changed." }, 400);
        return;
      }
      await auditDecision(loaded, "reject", "interactive_deny");
      const result = await rejectConsent({ consent_challenge: consentChallenge });
      const redirectTo = (result.body as { redirect_to?: string }).redirect_to;
      if (result.status === 200 && redirectTo) {
        res.redirect(redirectTo);
        return;
      }
      sendError(res, result.body, result.status);
    } catch (e) {
      sendError(res, { error: "consent_error", error_description: e instanceof Error ? e.message : "Consent error" }, 500);
    }
  });

  /**
   * GET /logout — terminate the Kratos session first (so the user isn't silently
   * signed back in), then either:
   *  - `logout_challenge` present (Hydra OAuth logout): accept the challenge and
   *    redirect on to Hydra; or
   *  - no challenge (session-only logout, e.g. the admin console): redirect back
   *    to an allowlisted `return_to`.
   * Kratos clears the session cookie via Set-Cookie, which we relay to the browser.
   */
  router.get("/logout", async (req: Request, res: Response): Promise<void> => {
    const logoutChallenge = first(req.query["logout_challenge"]);

    // Best-effort Kratos session termination, common to both paths. A 401 means
    // there's no active session — nothing to terminate.
    try {
      const init = await kratos.initLogout(req);
      // Prefer rebuilding from the token (internal URL) over Kratos's
      // logout_url, which points at the public HTTPS host — keeping this call
      // server-side over the internal address.
      const performUrl =
        init.logout_token ? kratos.logoutTokenUrl(init.logout_token) : init.logout_url ?? null;
      if (performUrl) {
        const setCookies = await kratos.performLogout(performUrl, req);
        for (const c of setCookies) res.append("Set-Cookie", c);
      }
    } catch {
      /* no active Kratos session or init failed */
    }

    // Session-only logout: the Kratos session is now cleared; send the browser
    // back to the app's allowlisted return_to.
    if (!logoutChallenge) {
      const returnTo = first(req.query["return_to"]);
      const clientId = first(req.query["client_id"]);
      if (returnTo && await isAllowedReturnTo(returnTo, clientId)) {
        res.redirect(returnTo);
        return;
      }
      sendError(res, { error: "missing_logout_challenge", error_description: "Missing logout_challenge." });
      return;
    }

    const result = await acceptLogout({ logout_challenge: logoutChallenge });
    const redirectTo = (result.body as { redirect_to?: string }).redirect_to;
    if (result.status === 200 && redirectTo) {
      res.redirect(redirectTo);
      return;
    }
    sendError(res, result.body, result.status);
  });

  /**
   * GET /error — Hydra's configured error sink. Shows a safe, whitelisted view
   * of the error, enriching from Kratos's error store when an `id` is present.
   */
  router.get("/error", async (req: Request, res: Response): Promise<void> => {
    const id = first(req.query["id"]);
    if (id) {
      try {
        const kratosErr = await kratos.getKratosError(id, req);
        sendError(res, kratosErr, 400);
        return;
      } catch {
        /* fall through to query-param based error */
      }
    }

    const payload = {
      error: first(req.query["error"]) ?? "unknown_error",
      error_description: first(req.query["error_description"]),
      error_hint: first(req.query["error_hint"]),
    };
    sendError(res, payload, 400);
  });

  return router;
}
