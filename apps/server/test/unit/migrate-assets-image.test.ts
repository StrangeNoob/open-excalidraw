import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../..");

/**
 * The migration CLI is only useful inside the production container, where
 * the asset volume is reachable. Both the bundle step and the COPY must stay
 * in the image or the documented migration command silently disappears.
 */
describe("asset migration CLI image packaging", () => {
  it("bundles and ships migrate-assets.mjs in the production image", async () => {
    const dockerfile = await readFile(
      join(ROOT, "apps/server/Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toMatch(/run bundle:migrate-assets$/m);
    expect(dockerfile).toMatch(
      /COPY --from=build --chown=10001:10001 \/workspace\/apps\/server\/dist\/migrate-assets\.mjs \.\/migrate-assets\.mjs/,
    );
  });
});
