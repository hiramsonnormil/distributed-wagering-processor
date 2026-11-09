import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { Migration20261106000000_init } from "./migrations/Migration20261106000000_init";
import { Migration20261109000000_single_reversal } from "./migrations/Migration20261109000000_single_reversal";

/**
 * Usamos MikroORM principalmente pela EntityManager.transactional() e pelo Migrator.
 * As operações financeiras usam SQL explícito (SELECT ... FOR UPDATE / INSERT ... ON CONFLICT)
 * para deixar a estratégia de concorrência visível — ver ARCHITECTURE.md.
 */
export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering",
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      { name: "Migration20261106000000_init", class: Migration20261106000000_init },
      { name: "Migration20261109000000_single_reversal", class: Migration20261109000000_single_reversal },
    ],
    transactional: true,
  },
  pool: { min: 2, max: 20 },
});
