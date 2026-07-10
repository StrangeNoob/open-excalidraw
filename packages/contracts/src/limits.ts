export const CONTRACT_LIMITS = {
  assetManifestEntries: 10_000,
  drawingTitleCharacters: 120,
  elementsPerPatch: 5_000,
  elementsPerScene: 50_000,
  fileIdCharacters: 256,
  problemDetailCharacters: 4_096,
  sceneBytes: 10 * 1024 * 1024,
} as const;
