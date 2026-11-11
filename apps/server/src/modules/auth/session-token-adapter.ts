import { createHash } from "node:crypto";

import type {
  BetterAuthOptions,
  DBAdapter,
  DBAdapterInstance,
  DBTransactionAdapter,
  Where,
} from "better-auth";

const HASH_PREFIX = "sha256:";

export function hashSessionToken(token: string): string {
  if (token.startsWith(HASH_PREFIX)) {
    return token;
  }

  return `${HASH_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

/**
 * Better Auth stores database session tokens verbatim by default. This adapter
 * hashes token values before every session-table write or predicate while
 * restoring the caller's raw token on request-scoped results so cookie refresh
 * remains compatible with Better Auth.
 */
export function withHashedSessionTokens(
  baseFactory: DBAdapterInstance,
): DBAdapterInstance {
  return (options: BetterAuthOptions) => wrapAdapter(baseFactory(options));
}

function wrapAdapter(adapter: DBAdapter): DBAdapter {
  const transformWhere = (model: string, where: Where[] | undefined) =>
    model === "session" ? hashTokenWhere(where) : where;

  const restoreResult = <T>(
    model: string,
    value: T,
    where?: Where[],
    originalToken?: string,
  ): T => {
    if (model !== "session") {
      return value;
    }

    const tokenMap = tokenMapFromWhere(where);
    if (originalToken) {
      tokenMap.set(hashSessionToken(originalToken), originalToken);
    }
    return restoreSessionTokens(value, tokenMap);
  };

  const wrapped: DBAdapter = {
    ...adapter,
    create: async <T extends Record<string, unknown>, R = T>(input: {
      model: string;
      data: Omit<T, "id">;
      select?: string[];
      forceAllowId?: boolean;
    }): Promise<R> => {
      const rawToken = sessionTokenFromRecord(input.model, input.data);
      const data = hashTokenRecord(input.model, input.data);
      const result = await adapter.create<T, R>({ ...input, data });
      return restoreResult(input.model, result, undefined, rawToken);
    },
    findOne: async <T>(input: {
      model: string;
      where: Where[];
      select?: string[];
      join?: Parameters<DBAdapter["findOne"]>[0]["join"];
    }): Promise<T | null> => {
      const where = transformWhere(input.model, input.where) ?? [];
      const result = await adapter.findOne<T>({ ...input, where });
      return restoreResult(input.model, result, input.where);
    },
    findMany: async <T>(input: Parameters<DBAdapter["findMany"]>[0]) => {
      const where = transformWhere(input.model, input.where);
      const result = await adapter.findMany<T>({ ...input, where });
      return restoreResult(input.model, result, input.where);
    },
    count: (input) =>
      adapter.count({
        ...input,
        where: transformWhere(input.model, input.where),
      }),
    update: async <T>(input: Parameters<DBAdapter["update"]>[0]) => {
      const where = transformWhere(input.model, input.where) ?? [];
      const update = hashTokenRecord(input.model, input.update);
      const result = await adapter.update<T>({ ...input, where, update });
      return restoreResult(input.model, result, input.where);
    },
    updateMany: (input) =>
      adapter.updateMany({
        ...input,
        where: transformWhere(input.model, input.where) ?? [],
        update: hashTokenRecord(input.model, input.update),
      }),
    delete: <T>(input: Parameters<DBAdapter["delete"]>[0]) =>
      adapter.delete<T>({
        ...input,
        where: transformWhere(input.model, input.where) ?? [],
      }),
    deleteMany: (input) =>
      adapter.deleteMany({
        ...input,
        where: transformWhere(input.model, input.where) ?? [],
      }),
    consumeOne: async <T>(input: Parameters<DBAdapter["consumeOne"]>[0]) => {
      const where = transformWhere(input.model, input.where) ?? [];
      const result = await adapter.consumeOne<T>({ ...input, where });
      return restoreResult(input.model, result, input.where);
    },
    incrementOne: async <T>(
      input: Parameters<DBAdapter["incrementOne"]>[0],
    ) => {
      const where = transformWhere(input.model, input.where) ?? [];
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
  if (model !== "session" || typeof record.token !== "string") {
    return record;
  }

  return { ...record, token: hashSessionToken(record.token) };
}

function sessionTokenFromRecord(
  model: string,
  record: Record<string, unknown>,
): string | undefined {
  return model === "session" && typeof record.token === "string"
    ? record.token
    : undefined;
}

function hashTokenWhere(where: Where[] | undefined): Where[] | undefined {
  return where?.map((condition) => {
    if (condition.field !== "token") {
      return condition;
    }

    return {
      ...condition,
      value: Array.isArray(condition.value)
        ? condition.value.map((token) => hashSessionToken(String(token)))
        : typeof condition.value === "string"
          ? hashSessionToken(condition.value)
          : condition.value,
    };
  });
}

function tokenMapFromWhere(where: Where[] | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const condition of where ?? []) {
    if (condition.field !== "token") {
      continue;
    }

    const values = Array.isArray(condition.value)
      ? condition.value
      : [condition.value];
    for (const value of values) {
      if (typeof value === "string") {
        tokens.set(hashSessionToken(value), value);
      }
    }
  }
  return tokens;
}

function restoreSessionTokens<T>(value: T, tokens: Map<string, string>): T {
  if (Array.isArray(value)) {
    const restoredItems: unknown[] = [];
    for (const item of value as unknown[]) {
      restoredItems.push(restoreSessionTokens(item, tokens));
    }
    return restoredItems as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const restored: Record<string, unknown> = { ...record };
  if (typeof record.token === "string") {
    restored.token = tokens.get(record.token) ?? record.token;
  }
  if (record.user && typeof record.user === "object") {
    restored.user = record.user;
  }
  return restored as T;
}
