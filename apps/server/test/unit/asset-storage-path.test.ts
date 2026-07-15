import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../..");

/**
 * The server falls back to <cwd>/uploads when STORAGE_LOCAL_PATH is unset,
 * but in the image that path is root-owned while the process runs as a
 * non-root user — every asset upload then 503s. The image must default
 * STORAGE_LOCAL_PATH to the writable directory it prepares.
 */
describe("asset storage path", () => {
  it("defaults STORAGE_LOCAL_PATH to the prepared writable directory", async () => {
    const dockerfile = await readFile(
      join(ROOT, "apps/server/Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toMatch(/^ENV STORAGE_LOCAL_PATH=\/data\/assets$/m);
    expect(dockerfile).toMatch(/mkdir -p \/data\/assets/);
    expect(dockerfile).toMatch(/chown -R 10001:10001 \/data\/assets/);
  });
});
