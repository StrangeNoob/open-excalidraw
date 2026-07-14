import { InvalidStorageKeyError, S3ObjectStorage } from "../src/index.js";

function storage(maxObjectBytes?: number) {
  // The endpoint is never reached: every case below must fail validation
  // before the driver issues a network request.
  return new S3ObjectStorage({
    bucket: "unreachable",
    endpoint: "http://127.0.0.1:1",
    accessKeyId: "test",
    secretAccessKey: "test",
    forcePathStyle: true,
    ...(maxObjectBytes === undefined ? {} : { maxObjectBytes }),
  });
}

function body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* generate() {
    await Promise.resolve();
    yield* chunks;
  })();
}

describe("S3ObjectStorage", () => {
  it.each([Number.NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maxObjectBytes %p",
    (maxObjectBytes) => {
      expect(() => storage(maxObjectBytes)).toThrowError(RangeError);
    },
  );

  it.each([
    "",
    "/absolute",
    "../outside",
    "nested/../../outside",
    "nested//object",
    "nested/./object",
    "nested\\object",
    "trailing/",
  ])("rejects unsafe key %j before any network call", async (key) => {
    const instance = storage();
    const chunk = new TextEncoder().encode("x");
    await expect(instance.put(key, body(chunk))).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
    await expect(instance.get(key)).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
    await expect(instance.stat(key)).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
    await expect(instance.delete(key)).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
  });

  it("rejects an invalid per-call maxBytes without a network call", async () => {
    const chunk = new TextEncoder().encode("x");
    await expect(
      storage().put("object", body(chunk), { maxBytes: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
