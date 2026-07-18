import {
  saveLibraryRequestSchema,
  type LibraryResponse,
} from "@open-excalidraw/contracts";

import { toLibraryResponse, type LibraryRepository } from "./types.js";

export class LibraryService {
  public constructor(private readonly repository: LibraryRepository) {}

  public async load(userId: string): Promise<LibraryResponse> {
    return toLibraryResponse(await this.repository.get(userId));
  }

  public async save(userId: string, body: unknown): Promise<LibraryResponse> {
    const request = saveLibraryRequestSchema.parse(body);
    return toLibraryResponse(await this.repository.put(userId, request.items));
  }
}
