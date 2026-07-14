import { join } from "node:path";

import {
  LocalObjectStorage,
  S3ObjectStorage,
  type ObjectStorage,
} from "@open-excalidraw/storage";

export function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/** Build a storage driver from the environment. Shared by the server and the
 * asset migration CLI so both resolve configuration identically. */
export function createStorageFromEnvironment(driver: string): ObjectStorage {
  if (driver === "local") {
    return new LocalObjectStorage({
      rootDirectory:
        process.env.STORAGE_LOCAL_PATH ?? join(process.cwd(), "uploads"),
    });
  }
  if (driver === "s3") {
    return new S3ObjectStorage({
      bucket: requiredEnvironment("S3_BUCKET"),
      region: process.env.S3_REGION?.trim() || undefined,
      endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
      accessKeyId: requiredEnvironment("S3_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnvironment("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    });
  }
  throw new Error('STORAGE_DRIVER must be "local" or "s3"');
}
