import { Component, computed, DestroyRef, inject, signal, type OnInit } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { NavigationEnd, Router } from "@angular/router";
import { filter } from "rxjs";
import { AdminAuthService } from "../core/admin-auth.service";
import { AdminApiService } from "../core/admin-api.service";
import { identityName } from "../core/admin-types";
import type { AdminShellNavGroup } from "./admin-shell.types";
import { AdminShellHeaderComponent } from "./header/admin-shell-header.component";
import { AdminShellLeftDrawerComponent } from "./left-drawer/admin-shell-left-drawer.component";
import { AdminShellMainContentComponent } from "./main-content/admin-shell-main-content.component";

@Component({
  selector: "app-shell",
  standalone: true,
  imports: [AdminShellHeaderComponent, AdminShellLeftDrawerComponent, AdminShellMainContentComponent],
  templateUrl: "./shell.component.html",
  styleUrls: ["./shell.component.css"],
})
export class ShellComponent implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly auth = inject(AdminAuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private destroyed = false;

  protected readonly navGroups: readonly AdminShellNavGroup[] = [
    {
      key: "identities-access",
      label: "Identities & Access",
      subtitle: "Users, roles, and OAuth clients",
      children: [
        { label: "Identities", path: "/identities", icon: "users" },
        { label: "OAuth Clients", path: "/clients", icon: "key-round" },
        { label: "Delegated Access", path: "/delegation", icon: "link" },
        { label: "Auth Brands", path: "/authentication/brands", icon: "palette" },
        {
          label: "Authentication Policies",
          path: "/authentication/policies",
          icon: "shield-check",
        },

        { label: "Client Mappings", path: "/authentication/client-mappings", icon: "link" },
      ],
    },
  ];

  private readonly currentUrl = signal(this.router.url);

  protected readonly activePath = computed(() => {
    const url = this.currentUrl().split(/[?#]/)[0] ?? "";
    for (const group of this.navGroups) {
      const active = group.children.find(
        (c) => url === c.path || url.startsWith(`${c.path}/`),
      );
      if (active) return active.path;
    }
    return null;
  });

  drawerCollapsed = false;
  displayName = "";
  pageTitle = "Identities";

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
  }

  async ngOnInit(): Promise<void> {
    this.syncPageTitle();
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((e) => {
        this.currentUrl.set(e.urlAfterRedirects);
        this.syncPageTitle();
      });

    try {
      const me = await this.api.me();
      await this.setDisplayNameAfterCurrentCheck(identityName(me.identity) || me.email);
    } catch {
      // Guard already gated entry; ignore transient failure.
    }
  }

  toggleDrawer(): void {
    this.drawerCollapsed = !this.drawerCollapsed;
  }

  signOut(): void {
    void this.auth.signOut();
  }

  protected onNavValueChange(value: unknown): void {
    if (typeof value !== "string" || value.length === 0) return;
    void this.router.navigateByUrl(value);
  }

  private syncPageTitle(): void {
    const path = this.router.url.split("?")[0] ?? "";
    if (path.startsWith("/clients")) {
      this.pageTitle = "OAuth Clients";
      return;
    }
    if (path.startsWith("/delegation")) {
      this.pageTitle = "Delegated Access";
      return;
    }
    if (path.startsWith("/authentication/brands")) {
      this.pageTitle = "Auth Brands";
      return;
    }
    if (path.startsWith("/authentication/policies")) {
      this.pageTitle = "Authentication Policies";
      return;
    }
    if (path.startsWith("/authentication/client-mappings")) {
      this.pageTitle = "Client Mappings";
      return;
    }
    if (path.startsWith("/identities/")) {
      this.pageTitle = "Identity Detail";
      return;
    }
    this.pageTitle = "Identities";
  }

  private async setDisplayNameAfterCurrentCheck(displayName: string): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!this.destroyed) {
      this.displayName = displayName;
    }
  }
}
