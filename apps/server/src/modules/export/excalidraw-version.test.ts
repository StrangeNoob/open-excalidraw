import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (relative: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../..", relative), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

/**
 * The server renders scenes with the same library the editor draws them with.
 * Two versions would mean two element semantics, so the exports the agent
 * looks at could disagree with the canvas a human sees.
 */
it("pins @excalidraw/excalidraw to the version apps/web uses", () => {
  const server =
    read("package.json").devDependencies?.["@excalidraw/excalidraw"];
  const web = read("../web/package.json").dependencies?.[
    "@excalidraw/excalidraw"
  ];

  expect(server).toBeDefined();
  expect(server).toBe(web);
  // Ranges would let the two drift apart on a lockfile refresh.
  expect(server).toMatch(/^\d+\.\d+\.\d+$/);
});
