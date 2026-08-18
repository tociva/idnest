import { inject, Injectable } from "@angular/core";
import { ADMIN_CONFIG } from "./admin-config";
import { IDNEST_ADMIN_CLIENT_ID } from "./admin-types";

interface AdminMeResponse {
  csrfToken?: string;
}

@Injectable({ providedIn: "root" })
export class AdminAuthService {
  private readonly config = inject(ADMIN_CONFIG);
  private csrfToken = "";

  initialize(): void {
    // BFF sessions live in an HttpOnly cookie; there is no browser token state.
  }

  setCsrfToken(token: string | undefined): void {
    this.csrfToken = token ?? "";
  }

  getCsrfToken(): string {
    return this.csrfToken;
  }

  async ensureCsrfToken(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    const res = await fetch(`${this.adminBase()}/me`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return "";
    const body = (await res.json().catch(() => null)) as AdminMeResponse | null;
    this.setCsrfToken(body?.csrfToken);
    return this.csrfToken;
  }

  signIn(returnTo = window.location.href): void {
    const params = new URLSearchParams({ return_to: sameOriginPath(returnTo) ?? "/" });
    window.location.href = `${this.adminBase()}/auth/login?${params.toString()}`;
  }

  async signOut(): Promise<void> {
    await this.endAdminSession();
    window.location.href = this.upstreamLogoutUrl();
  }

  async endAdminSession(): Promise<void> {
    const csrf = await this.ensureCsrfToken();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (csrf) headers["X-Admin-CSRF"] = csrf;
    try {
      await fetch(`${this.adminBase()}/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers,
      });
    } finally {
      this.clearLocalSession();
    }
  }

  clearLocalSession(): void {
    this.csrfToken = "";
  }

  clearPendingSignIn(): void {
    // Kept for the old callback/pending components; BFF login has no browser transaction.
  }

  completeSignIn(): Promise<string> {
    return Promise.resolve("/");
  }

  private adminBase(): string {
    return `${this.config.apiBaseUrl.replace(/\/+$/, "")}/admin`;
  }

  private upstreamLogoutUrl(): string {
    const returnTo = new URL("/auth/logout", window.location.origin);
    returnTo.searchParams.set("sso", "done");
    const configuredLogoutUrl = this.config.authLogoutUrl?.includes("${")
      ? undefined
      : this.config.authLogoutUrl;
    const logoutUrl = new URL(configuredLogoutUrl || defaultAuthLogoutUrl(), window.location.origin);
    logoutUrl.searchParams.set("return_to", returnTo.toString());
    logoutUrl.searchParams.set("client_id", IDNEST_ADMIN_CLIENT_ID);
    return logoutUrl.toString();
  }
}

function sameOriginPath(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function defaultAuthLogoutUrl(): string {
  const url = new URL(window.location.href);
  if (url.hostname.startsWith("admin-local.")) {
    url.hostname = url.hostname.replace(/^admin-local\./, "auth-local.");
  } else if (url.hostname.startsWith("admin.")) {
    url.hostname = url.hostname.replace(/^admin\./, "auth.");
  } else {
    return "/logout";
  }
  url.pathname = "/logout";
  url.search = "";
  url.hash = "";
  return url.toString();
}
