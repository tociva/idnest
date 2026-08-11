// Default email_verified to false so the expression is safe even if Google
// omits the claim. Only map the required email trait when Google marks it
// verified; otherwise Kratos rejects the OIDC flow during identity validation.
local claims = { email_verified: false } + std.extVar('claims');

{
  identity: {
    traits: {
      [if 'email' in claims && claims.email_verified then 'email' else null]: claims.email,
      // Google may omit optional profile claims even when the profile scope was requested.
      [if 'name' in claims then 'name' else null]: claims.name,
      [if 'picture' in claims then 'picture' else null]: claims.picture,
    },
    // Any verifiable address (see identity.schema.json) matching an entry here
    // is automatically marked verified once the identity passes validation.
    verified_addresses: std.prune([
      if 'email' in claims && claims.email_verified then { via: 'email', value: claims.email },
    ]),
  },
}
