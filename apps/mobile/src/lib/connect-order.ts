/** Which address to try first for a saved connection. Pure, so it is unit-testable. */

/** Addresses to try for a connection, last-known-good first and without duplicates. */
export function connectOrder(connection: { baseUrl: string; candidates: string[] }): string[] {
  return [connection.baseUrl, ...connection.candidates.filter((c) => c !== connection.baseUrl)];
}
