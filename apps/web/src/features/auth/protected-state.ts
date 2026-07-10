export type ProtectedStatePurge = () => Promise<void> | void;

const protectedStatePurges = new Set<ProtectedStatePurge>();

export const registerProtectedStatePurge = (purge: ProtectedStatePurge) => {
  protectedStatePurges.add(purge);

  return () => {
    protectedStatePurges.delete(purge);
  };
};

export const purgeProtectedState = async (): Promise<void> => {
  await Promise.allSettled(
    [...protectedStatePurges].map(async (purge) => {
      await purge();
    }),
  );
};
