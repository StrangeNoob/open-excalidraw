import { createHash } from "node:crypto";

import type {
  BetterAuthOptions,
  DBAdapter,
  DBAdapterInstance,
  DBTransactionAdapter,
  Where,
} from "better-auth";

const HASH_PREFIX = "sha256:";

/**
 * Model fields Better Auth stores verbatim but that are bearer secrets: the
 * database session token, and the MCP plugin's OAuth access and refresh tokens.
 */
const HASHED_FIELDS: Record<string, readonly string[]> = {
  session: ["token"],
  oauthAccessToken: ["accessToken", "refreshToken"],
};

/**
 * Always hashes, never passes a value through. Results carry the caller's raw
 * token back out (see `restoreTokens`), so nothing legitimately presents a
 * digest here — and treating one as already-hashed would make the stored value
 * a working credential in its own right.
 */
export function hashAuthToken(token: string): string {
  return `${HASH_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

/**
 * Better Auth stores these token values verbatim by default. This adapter
 * hashes them before every write or predicate while restoring the caller's raw
 * token on request-scoped results, so cookie refresh and the token endpoint's
 * response stay compatible with Better Auth.
 */
export function withHashedTokens(
  baseFactory: DBAdapterInstance,
): DBAdapterInstance {
  return (options: BetterAuthOptions) => wrapAdapter(baseFactory(options));
}

function wrapAdapter(adapter: DBAdapter): DBAdapter {
  const restoreResult = <T>(
    model: string,
    value: T,
    where?: Where[],
    originalRecord?: Record<string, unknown>,
  ): T => {
    const fields = HASHED_FIELDS[model];
    if (!fields) {
      return value;
    }

    const tokens = tokenMapFromWhere(fields, where);
    for (const field of fields) {
      const raw = originalRecord?.[field];
      if (typeof raw === "string") {
        tokens.set(hashAuthToken(raw), raw);
      }
    }
    return restoreTokens(fields, value, tokens);
  };

  const wrapped: DBAdapter = {
    ...adapter,
    create: async <T extends Record<string, unknown>, R = T>(input: {
      model: string;
      data: Omit<T, "id">;
      select?: string[];
      forceAllowId?: boolean;
    }): Promise<R> => {
      const data = hashTokenRecord(input.model, input.data);
      const result = await adapter.create<T, R>({ ...input, data });
      return restoreResult(input.model, result, undefined, input.data);
    },
    findOne: async <T>(input: {
      model: string;
      where: Where[];
      select?: string[];
      join?: Parameters<DBAdapter["findOne"]>[0]["join"];
    }): Promise<T | null> => {
      const where = hashTokenWhere(input.model, input.where) ?? [];
      const result = await adapter.findOne<T>({ ...input, where });
      return restoreResult(input.model, result, input.where);
    },
    findMany: async <T>(input: Parameters<DBAdapter["findMany"]>[0]) => {
      const where = hashTokenWhere(input.model, input.where);
      const result = await adapter.findMany<T>({ ...input, where });
      return restoreResult(input.model, result, input.where);
    },
    count: (input) =>
      adapter.count({
        ...input,
        where: hashTokenWhere(input.model, input.where),
      }),
    update: async <T>(input: Parameters<DBAdapter["update"]>[0]) => {
      const where = hashTokenWhere(input.model, input.where) ?? [];
      const update = hashTokenRecord(input.model, input.update);
      const result = await adapter.update<T>({ ...input, where, update });
      // The update's own raw values matter as much as the predicate's: an
      // update that sets a fresh token would otherwise hand the caller back
      // the digest it just stored.
      return restoreResult(input.model, result, input.where, input.update);
    },
    updateMany: (input) =>
      adapter.updateMany({
        ...input,
        where: hashTokenWhere(input.model, input.where) ?? [],
        update: hashTokenRecord(input.model, input.update),
      }),
    delete: <T>(input: Parameters<DBAdapter["delete"]>[0]) =>
      adapter.delete<T>({
        ...input,
        where: hashTokenWhere(input.model, input.where) ?? [],
      }),
    deleteMany: (input) =>
      adapter.deleteMany({
        ...input,
        where: hashTokenWhere(input.model, input.where) ?? [],
      }),
    consumeOne: async <T>(input: Parameters<DBAdapter["consumeOne"]>[0]) => {
      const where = hashTokenWhere(input.model, input.where) ?? [];
      const result = await adapter.consumeOne<T>({ ...input, where });
      return restoreResult(input.model, result, input.where);
    },
    incrementOne: async <T>(
      input: Parameters<DBAdapter["incrementOne"]>[0],
    ) => {
      const where = hashTokenWhere(input.model, input.where) ?? [];
      const result = await adapter.incrementOne<T>({ ...input, where });
      return restoreResult(input.model, result, input.where);
    },
    transaction: <R>(
      callback: (transaction: DBTransactionAdapter) => Promise<R>,
    ) =>
      adapter.transaction((transaction) =>
        callback(wrapAdapter(transaction as DBAdapter)),
      ),
  };

  return wrapped;
}

function hashTokenRecord<T extends Record<string, unknown>>(
  model: string,
  record: T,
): T {
  const fields = HASHED_FIELDS[model];
  if (!fields) {
    return record;
  }

  const hashed = { ...record };
  for (const field of fields) {
    const value = hashed[field];
    if (typeof value === "string") {
      (hashed as Record<string, unknown>)[field] = hashAuthToken(value);
    }
  }
  return hashed;
}

function hashTokenWhere(
  model: string,
  where: Where[] | undefined,
): Where[] | undefined {
  const fields = HASHED_FIELDS[model];
  if (!fields) {
    return where;
  }

  return where?.map((condition) => {
    if (!fields.includes(condition.field)) {
      return condition;
    }

    return {
      ...condition,
      value: Array.isArray(condition.value)
        ? condition.value.map((token) => hashAuthToken(String(token)))
        : typeof condition.value === "string"
          ? hashAuthToken(condition.value)
          : condition.value,
    };
  });
}

function tokenMapFromWhere(
  fields: readonly string[],
  where: Where[] | undefined,
): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const condition of where ?? []) {
    if (!fields.includes(condition.field)) {
      continue;
    }

    const values = Array.isArray(condition.value)
      ? condition.value
      : [condition.value];
    for (const value of values) {
      if (typeof value === "string") {
        tokens.set(hashAuthToken(value), value);
      }
    }
  }
  return tokens;
}

function restoreTokens<T>(
  fields: readonly string[],
  value: T,
  tokens: Map<string, string>,
): T {
  if (Array.isArray(value)) {
    const restoredItems: unknown[] = [];
    for (const item of value as unknown[]) {
      restoredItems.push(restoreTokens(fields, item, tokens));
    }
    return restoredItems as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const restored: Record<string, unknown> = { ...record };
  for (const field of fields) {
    const stored = record[field];
    if (typeof stored === "string") {
      restored[field] = tokens.get(stored) ?? stored;
    }
  }
  if (record.user && typeof record.user === "object") {
    restored.user = record.user;
  }
  return restored as T;
}
