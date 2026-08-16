import {
  createAuthzPool,
  migrateAuthzSchema,
} from "../../monorepo/libs/authz-store/src/index";
import { loadMonorepoEnv } from "./load-monorepo-env";

if (!process.env.AUTHZ_DATABASE_URL) loadMonorepoEnv();

async function main() {
  const url = process.env.AUTHZ_DATABASE_URL;
  if (!url) throw new Error("AUTHZ_DATABASE_URL is required");
  const pool = createAuthzPool(url);
  try {
    await migrateAuthzSchema(pool);
    console.log("Authz schema migrated.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
