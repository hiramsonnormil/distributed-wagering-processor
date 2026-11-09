import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "./mikro-orm.config";

/** bun run migration:up | migration:down — migrations versionadas e reversíveis. */
const direction = process.argv[2] === "down" ? "down" : "up";
const orm = await MikroORM.init(config);
const migrator = orm.getMigrator();
const done = direction === "up" ? await migrator.up() : await migrator.down();
console.log(JSON.stringify({ level: "info", msg: `migrations ${direction}`, migrations: done.map((m) => m.name) }));
await orm.close();
