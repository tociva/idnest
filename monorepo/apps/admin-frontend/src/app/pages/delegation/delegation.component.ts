import { Component, DestroyRef, inject, type OnInit } from "@angular/core";
import { FormsModule } from "@angular/forms";
import type { DelegationStatus } from "@idnest/shared-types";
import {
  TngBadgeComponent,
  TngButtonComponent,
  TngCardComponent,
  TngCardContentComponent,
  TngCardDescriptionComponent,
  TngCardHeaderComponent,
  TngCardTitleComponent,
  TngProgressSpinnerComponent,
} from "@tailng-ui/components";
import { TngIcon } from "@tailng-ui/icons";
import { AdminApiService, describeError } from "../../core/admin-api.service";
import type {
  DelegationActorPolicyRecord,
  DelegationAuditActivity,
  DelegationGrantActivity,
  DelegationResourceRecord,
} from "../../core/admin-types";
import { ToastService } from "../../core/toast/toast.service";

interface ResourceDraft {
  id: string;
  version: number;
  status: Exclude<DelegationStatus, "archived">;
  key: string;
  displayName: string;
  audience: string;
  authorizerClientId: string;
  scopes: string;
  tokenTtlSeconds: number;
  authorizationContextRequired: boolean;
}

interface ActorDraft {
  actorClientId: string;
  scopes: string;
  status: Exclude<DelegationStatus, "archived">;
}

function emptyResource(): ResourceDraft {
  return {
    id: "",
    version: 0,
    status: "active",
    key: "",
    displayName: "",
    audience: "",
    authorizerClientId: "",
    scopes: "",
    tokenTtlSeconds: 180,
    authorizationContextRequired: true,
  };
}

function emptyActor(): ActorDraft {
  return { actorClientId: "", scopes: "", status: "active" };
}

@Component({
  selector: "app-delegation",
  standalone: true,
  imports: [
    FormsModule,
    TngBadgeComponent,
    TngButtonComponent,
    TngCardComponent,
    TngCardContentComponent,
    TngCardDescriptionComponent,
    TngCardHeaderComponent,
    TngCardTitleComponent,
    TngIcon,
    TngProgressSpinnerComponent,
  ],
  templateUrl: "./delegation.component.html",
  styleUrls: ["./delegation.component.css"],
})
export class DelegationComponent implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toast = inject(ToastService);
  private destroyed = false;

  resources: DelegationResourceRecord[] = [];
  actorPolicies: DelegationActorPolicyRecord[] = [];
  grants: DelegationGrantActivity[] = [];
  auditEvents: DelegationAuditActivity[] = [];
  resourceForm = emptyResource();
  actorForm = emptyActor();
  resourceReason = "";
  actorReason = "";
  activeTab: "configuration" | "activity" = "configuration";
  loading = true;
  busy = false;
  error = "";

  private readonly dateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  get selectedResource(): DelegationResourceRecord | undefined {
    return this.resources.find((resource) => resource.id === this.resourceForm.id);
  }

  get createMode(): boolean {
    return !this.resourceForm.id;
  }

  selectResource(resource: DelegationResourceRecord): void {
    this.resourceForm = {
      id: resource.id,
      version: resource.version,
      status: resource.status === "archived" ? "disabled" : resource.status,
      key: resource.definition.key,
      displayName: resource.definition.displayName,
      audience: resource.definition.audience,
      authorizerClientId: resource.definition.authorizerClientId,
      scopes: resource.definition.allowedScopes.join(" "),
      tokenTtlSeconds: resource.definition.tokenTtlSeconds,
      authorizationContextRequired: resource.definition.authorizationContextRequired,
    };
    this.resourceReason = "";
    this.actorForm = emptyActor();
    this.actorReason = "";
    void this.loadResourceDetails(resource.id);
  }

  newResource(): void {
    this.resourceForm = emptyResource();
    this.actorPolicies = [];
    this.actorForm = emptyActor();
    this.resourceReason = "";
    void this.loadActivity();
  }

  editActor(policy: DelegationActorPolicyRecord): void {
    this.actorForm = {
      actorClientId: policy.definition.actorClientId,
      scopes: policy.definition.allowedScopes.join(" "),
      status: policy.status === "archived" ? "disabled" : policy.status,
    };
    this.actorReason = "";
  }

  newActor(): void {
    this.actorForm = emptyActor();
    this.actorReason = "";
  }

  async saveResource(): Promise<void> {
    const draft = this.resourceForm;
    const definition = {
      key: draft.key.trim(),
      displayName: draft.displayName.trim(),
      audience: draft.audience.trim(),
      authorizerClientId: draft.authorizerClientId.trim(),
      allowedScopes: this.scopeList(draft.scopes),
      tokenTtlSeconds: Number(draft.tokenTtlSeconds),
      authorizationContextRequired: draft.authorizationContextRequired,
    };
    await this.run(async () => {
      const saved = this.createMode
        ? await this.api.createDelegationResource(
            { status: draft.status, definition },
            this.resourceReason.trim() || "Created from delegated access administration",
          )
        : await this.api.updateDelegationResource(
            {
              id: draft.id,
              version: draft.version,
              status: draft.status,
              definition,
              created_at: this.selectedResource?.created_at ?? "",
              updated_at: this.selectedResource?.updated_at ?? "",
            },
            this.resourceReason.trim() || "Updated from delegated access administration",
          );
      this.toast.success(this.createMode ? "Delegation resource created" : "Delegation resource saved");
      await this.reloadAndSelect(saved.id);
    });
  }

  async archiveResource(): Promise<void> {
    const selected = this.selectedResource;
    if (!selected || !window.confirm(`Archive ${selected.definition.displayName}?`)) return;
    await this.run(async () => {
      await this.api.archiveDelegationResource(selected.id);
      this.toast.success("Delegation resource archived");
      this.newResource();
      await this.load();
    });
  }

  async saveActor(): Promise<void> {
    const selected = this.selectedResource;
    const actorClientId = this.actorForm.actorClientId.trim();
    if (!selected || !actorClientId) {
      this.toast.danger("Choose a resource and enter an actor OAuth client ID");
      return;
    }
    await this.run(async () => {
      await this.api.saveDelegationActorPolicy(
        selected.id,
        actorClientId,
        {
          status: this.actorForm.status,
          definition: {
            actorClientId,
            allowedScopes: this.scopeList(this.actorForm.scopes),
          },
        },
        this.actorReason.trim() || "Updated from delegated access administration",
      );
      this.toast.success("Actor policy saved");
      this.newActor();
      await this.loadResourceDetails(selected.id);
    });
  }

  async archiveActor(policy: DelegationActorPolicyRecord): Promise<void> {
    const selected = this.selectedResource;
    if (!selected || !window.confirm(`Remove ${policy.definition.actorClientId}?`)) return;
    await this.run(async () => {
      await this.api.archiveDelegationActorPolicy(
        selected.id,
        policy.definition.actorClientId,
      );
      this.toast.success("Actor policy removed");
      await this.loadResourceDetails(selected.id);
    });
  }

  async revokeGrant(grant: DelegationGrantActivity): Promise<void> {
    if (!this.isGrantPending(grant) || !window.confirm("Revoke this pending one-time grant?")) return;
    await this.run(async () => {
      await this.api.revokeDelegationGrant(grant.id);
      this.toast.success("Pending grant revoked");
      await this.loadActivity(this.selectedResource?.id);
    });
  }

  isGrantPending(grant: DelegationGrantActivity): boolean {
    return !grant.consumed_at && !grant.revoked_at && new Date(grant.expires_at).getTime() > Date.now();
  }

  grantState(grant: DelegationGrantActivity): string {
    if (grant.revoked_at) return "Revoked";
    if (grant.consumed_at) return "Exchanged";
    if (new Date(grant.expires_at).getTime() <= Date.now()) return "Expired";
    return "Pending";
  }

  dateLabel(value: string | null): string {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : this.dateFormatter.format(date);
  }

  scopeLabel(scopes: string[]): string {
    return scopes.join(" ") || "No scopes";
  }

  private scopeList(value: string): string[] {
    return [...new Set(value.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean))].sort();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = "";
    try {
      const [resources, grants, auditEvents] = await Promise.all([
        this.api.listDelegationResources(),
        this.api.listDelegationGrants(),
        this.api.listDelegationAudit(),
      ]);
      if (this.destroyed) return;
      this.resources = resources;
      this.grants = grants;
      this.auditEvents = auditEvents;
    } catch (error) {
      if (this.destroyed) return;
      this.error = describeError(error);
      this.toast.danger(this.error);
    } finally {
      if (!this.destroyed) this.loading = false;
    }
  }

  private async reloadAndSelect(id: string): Promise<void> {
    const resources = await this.api.listDelegationResources();
    if (this.destroyed) return;
    this.resources = resources;
    const saved = resources.find((resource) => resource.id === id);
    if (saved) this.selectResource(saved);
  }

  private async loadResourceDetails(resourceId: string): Promise<void> {
    try {
      const policies = await this.api.listDelegationActorPolicies(resourceId);
      if (!this.destroyed && this.resourceForm.id === resourceId) this.actorPolicies = policies;
      await this.loadActivity(resourceId);
    } catch (error) {
      if (!this.destroyed) this.toast.danger(describeError(error));
    }
  }

  private async loadActivity(resourceId?: string): Promise<void> {
    const [grants, auditEvents] = await Promise.all([
      this.api.listDelegationGrants(resourceId),
      this.api.listDelegationAudit(resourceId),
    ]);
    if (this.destroyed || (resourceId && this.resourceForm.id !== resourceId)) return;
    this.grants = grants;
    this.auditEvents = auditEvents;
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      await operation();
    } catch (error) {
      if (this.destroyed) return;
      this.error = describeError(error);
      this.toast.danger(this.error);
    } finally {
      if (!this.destroyed) this.busy = false;
    }
  }
}
