import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*.ts",
  out: "./migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://open_excalidraw:open_excalidraw@localhost:5432/open_excalidraw",
  },
  strict: true,
  verbose: true,
});
