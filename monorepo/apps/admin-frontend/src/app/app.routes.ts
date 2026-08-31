import { type Routes } from "@angular/router";
import { adminGuard } from "./core/admin.guard";

export const routes: Routes = [
  {
    path: "auth/callback",
    loadComponent: () =>
      import("./pages/auth-callback/auth-callback.component").then(
        (m) => m.AuthCallbackComponent,
      ),
  },
  {
    path: "auth/logout",
    loadComponent: () =>
      import("./pages/auth-logout/auth-logout.component").then((m) => m.AuthLogoutComponent),
  },
  {
    path: "auth/pending",
    loadComponent: () =>
      import("./pages/auth-pending/auth-pending.component").then((m) => m.AuthPendingComponent),
  },
  {
    path: "forbidden",
    loadComponent: () =>
      import("./pages/forbidden/forbidden.component").then((m) => m.ForbiddenComponent),
  },
  {
    path: "",
    canActivate: [adminGuard],
    loadComponent: () => import("./layout/shell.component").then((m) => m.ShellComponent),
    children: [
      {
        path: "identities",
        loadComponent: () =>
          import("./pages/identities/identities.component").then((m) => m.IdentitiesComponent),
      },
      {
        path: "identities/:id",
        loadComponent: () =>
          import("./pages/identity-detail/identity-detail.component").then(
            (m) => m.IdentityDetailComponent,
          ),
      },
      {
        path: "clients",
        loadComponent: () =>
          import("./pages/clients/clients.component").then((m) => m.ClientsComponent),
      },
      {
        path: "clients/new",
        loadComponent: () =>
          import("./pages/client-detail/client-detail.component").then(
            (m) => m.ClientDetailComponent,
          ),
      },
      {
        path: "clients/:clientId",
        loadComponent: () =>
          import("./pages/client-detail/client-detail.component").then(
            (m) => m.ClientDetailComponent,
          ),
      },
      {
        path: "delegation",
        loadComponent: () =>
          import("./pages/delegation/delegation.component").then(
            (m) => m.DelegationComponent,
          ),
      },
      { path: "authentication", pathMatch: "full", redirectTo: "authentication/brands" },
      {
        path: "authentication/brands",
        loadComponent: () =>
          import(
            "./pages/authentication/brands/auth-brands/auth-brands.component"
          ).then((m) => m.AuthBrandsComponent),
      },
      {
        path: "authentication/brands/new",
        loadComponent: () =>
          import(
            "./pages/authentication/brands/auth-brand-detail/auth-brand-detail.component"
          ).then((m) => m.AuthBrandDetailComponent),
      },
      {
        path: "authentication/brands/:id",
        loadComponent: () =>
          import(
            "./pages/authentication/brands/auth-brand-detail/auth-brand-detail.component"
          ).then((m) => m.AuthBrandDetailComponent),
      },
      {
        path: "authentication/policies",
        loadComponent: () =>
          import(
            "./pages/authentication/policies/auth-policies/auth-policies.component"
          ).then((m) => m.AuthPoliciesComponent),
      },
      {
        path: "authentication/policies/new",
        loadComponent: () =>
          import(
            "./pages/authentication/policies/auth-policy-detail/auth-policy-detail.component"
          ).then((m) => m.AuthPolicyDetailComponent),
      },
      {
        path: "authentication/policies/:id",
        loadComponent: () =>
          import(
            "./pages/authentication/policies/auth-policy-detail/auth-policy-detail.component"
          ).then((m) => m.AuthPolicyDetailComponent),
      },
      {
        path: "authentication/client-mappings",
        loadComponent: () =>
          import("./pages/authentication/client-mappings/auth-client-mappings.component").then(
            (m) => m.AuthClientMappingsComponent,
          ),
      },
      {
        path: "authentication/client-mappings/new",
        loadComponent: () =>
          import(
            "./pages/authentication/client-mappings/auth-client-mapping-detail.component"
          ).then((m) => m.AuthClientMappingDetailComponent),
      },
      {
        path: "authentication/client-mappings/:clientId",
        loadComponent: () =>
          import(
            "./pages/authentication/client-mappings/auth-client-mapping-detail.component"
          ).then((m) => m.AuthClientMappingDetailComponent),
      },
      { path: "", pathMatch: "full", redirectTo: "identities" },
    ],
  },
  { path: "**", redirectTo: "forbidden" },
];
