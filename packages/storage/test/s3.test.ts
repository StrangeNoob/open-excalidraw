import { S3Client } from "@aws-sdk/client-s3";

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

  it("requires a region when no custom endpoint is configured", () => {
    const options = {
      bucket: "assets",
      accessKeyId: "test",
      secretAccessKey: "test",
    };
    expect(() => new S3ObjectStorage(options)).toThrowError(/region/);
    expect(() => new S3ObjectStorage({ ...options, region: " " })).toThrowError(
      /region/,
    );
    expect(
      () => new S3ObjectStorage({ ...options, region: "us-east-1" }),
    ).not.toThrow();
    expect(
      () => new S3ObjectStorage({ ...options, endpoint: "http://127.0.0.1:1" }),
    ).not.toThrow();
  });
});

describe("conditional PUT fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to head-then-put after a 501 and stays fallen back", async () => {
    const sent: { command: string; conditional: boolean }[] = [];
    vi.spyOn(
      S3Client.prototype as unknown as {
        send: (command: unknown) => Promise<unknown>;
      },
      "send",
    ).mockImplementation((command) => {
      const name = (command as object).constructor.name;
      const input = (command as { input: { IfNoneMatch?: string } }).input;
      sent.push({ command: name, conditional: Boolean(input.IfNoneMatch) });
      if (name === "PutObjectCommand" && input.IfNoneMatch) {
        return Promise.reject(s3Error("NotImplemented", 501));
      }
      if (name === "HeadObjectCommand") {
        return Promise.reject(s3Error("NotFound", 404));
      }
      return Promise.resolve({});
    });

    const instance = storage();
    const chunk = new TextEncoder().encode("x");

    const first = await instance.put("first", body(chunk));
    expect(first.created).toBe(true);

    const second = await instance.put("second", body(chunk));
    expect(second.created).toBe(true);

    // Exactly one failed conditional attempt; the flag stays flipped and
    // every later write goes straight to the head-then-put fallback.
    expect(sent.filter((call) => call.conditional)).toHaveLength(1);
    expect(sent.map((call) => call.command)).toEqual([
      "PutObjectCommand",
      "HeadObjectCommand",
      "PutObjectCommand",
      "HeadObjectCommand",
      "PutObjectCommand",
    ]);
  });
});

function s3Error(name: string, httpStatusCode: number): Error {
  const error = new Error(name);
  error.name = name;
  Object.assign(error, { $metadata: { httpStatusCode } });
  return error;
}
