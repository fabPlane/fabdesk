/** Export at most two fresh native models at once. Keep results in board order and
 * settle all workers before the caller removes its scratch directory, even on abort. */
export async function exportEnclosureBoards<T, R>(
  boards: T[],
  exportBoard: (board: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(boards.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, boards.length) }, async () => {
      while (next < boards.length) {
        const index = next++;
        try {
          signal?.throwIfAborted();
          results[index] = { status: "fulfilled", value: await exportBoard(boards[index]!, index) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );
  signal?.throwIfAborted();
  return results;
}
