import type { ClerkPlayer } from "@spacemolt/lib";

/** The subset of a lib `Account` the account layer depends on. */
export interface LibAccountLike {
  readonly player?: { id: string };
  /** Clerk username / store id. Requires a `get username()` accessor on the real Account (Task 5). */
  readonly username?: string;
  onStateChange(listener: (changed: string[]) => void): void;
  close(): void;
}

/** The subset of the lib `SpacemoltClient` the account layer depends on. */
export interface AccountClientLike {
  connectOwned(opts: { filter?: (p: ClerkPlayer) => boolean }): Promise<LibAccountLike[]>;
  accounts(): LibAccountLike[];
  account(id: string): LibAccountLike | undefined;
  remove(id: string): Promise<void>;
  closeAll(): void;
}
