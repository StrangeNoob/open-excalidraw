import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../..");
const WEB = join(ROOT, "apps/web");

/**
 * The production image serves apps/web/dist. Vite only emits apps/web/public
 * into dist when that directory is present in the build context, and the image
 * copies the web app path by path — so an asset can exist locally, pass every
 * test against the dev server, and still 404 in production.
 */
describe("web static assets", () => {
  it("ships every root-relative asset index.html references", async () => {
    const html = await readFile(join(WEB, "index.html"), "utf8");
    const referenced = [...html.matchAll(/href="\/([^/"][^"]*)"/g)].flatMap(
      ([, path]) => path ?? [],
    );

    expect(referenced.length).toBeGreaterThan(0);

    for (const path of referenced) {
      await expect(
        access(join(WEB, "public", path)),
        `index.html references /${path}, which is missing from apps/web/public`,
      ).resolves.toBeUndefined();
    }
  });

  it("copies apps/web/public into the image build stage", async () => {
    const dockerfile = await readFile(
      join(ROOT, "apps/server/Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toMatch(/^COPY apps\/web\/public apps\/web\/public$/m);
  });

  it("serves the whole web build, so the service worker and manifest ship", async () => {
    const dockerfile = await readFile(
      join(ROOT, "apps/server/Dockerfile"),
      "utf8",
    );

    // dist is copied wholesale, so vite's generated sw.js, workbox chunk, and
    // manifest.webmanifest reach production without a path-by-path copy.
    expect(dockerfile).toMatch(
      /^COPY --from=build[^\n]* \/workspace\/apps\/web\/dist \.\/public$/m,
    );
  });
});
