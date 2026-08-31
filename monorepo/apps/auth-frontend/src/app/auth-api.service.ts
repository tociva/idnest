import { HttpClient, HttpErrorResponse } from "@angular/common/http";
import { inject, Injectable } from "@angular/core";
import type {
  AuthBrandDefinition,
  PublicAuthPolicy,
  PublicAuthRecovery,
} from "@idnest/shared-types";
import { firstValueFrom } from "rxjs";
import type { LoginFlowResponse } from "./auth-flow-response";

export interface ConsentContextResponse {
  transactionId: string;
  client: { id: string; displayName: string };
  recovery: PublicAuthRecovery;
  brand: AuthBrandDefinition;
  policy: PublicAuthPolicy;
  requestedScopes: string[];
  requestedAudiences: string[];
  expiresAt: string;
  acceptToken: string;
  rejectToken: string;
}

export interface AuthRecoveryErrorBody {
  error?: string;
  recovery?: PublicAuthRecovery;
}

@Injectable({ providedIn: "root" })
export class AuthApiService {
  private readonly http = inject(HttpClient);

  loginFlowContext(flowId: string): Promise<LoginFlowResponse> {
    return firstValueFrom(
      this.http.get<LoginFlowResponse>(
        `/auth/v1/flows/login/${encodeURIComponent(flowId)}/context`,
        { withCredentials: true },
      ),
    );
  }

  rejectLogin(transactionId: string): Promise<{ redirectTo: string }> {
    return firstValueFrom(
      this.http.post<{ redirectTo: string }>(
        `/auth/v1/transactions/${encodeURIComponent(transactionId)}/reject`,
        {},
        { withCredentials: true },
      ),
    );
  }

  consentContext(transactionId: string): Promise<ConsentContextResponse> {
    return firstValueFrom(
      this.http.get<ConsentContextResponse>(
        `/auth/v1/consent/${encodeURIComponent(transactionId)}/context`,
        { withCredentials: true },
      ),
    );
  }

  consentAction(
    transactionId: string,
    action: "accept" | "reject",
    actionToken: string,
  ): Promise<{ redirectTo: string }> {
    return firstValueFrom(
      this.http.post<{ redirectTo: string }>(
        `/auth/v1/consent/${encodeURIComponent(transactionId)}/${action}`,
        { actionToken },
        { withCredentials: true },
      ),
    );
  }

  recoveryFromError(error: unknown): PublicAuthRecovery | null {
    if (!(error instanceof HttpErrorResponse)) return null;
    const body = error.error as AuthRecoveryErrorBody | null;
    return body?.recovery ?? null;
  }
}
