/** Keep one expensive render in flight and only the newest waiting request. */
export function latestPreviewQueue<T, R>(
  send: (id: number, input: T) => void,
  commit: (result: R) => void,
) {
  let newest = 0;
  let active: number | null = null;
  let pending: { id: number; input: T } | null = null;
  const dispatch = (job: { id: number; input: T }) => {
    active = job.id;
    send(job.id, job.input);
  };
  return {
    cancel() {
      newest++;
      pending = null;
    },
    request(input: T) {
      const job = { id: ++newest, input };
      if (active === null) dispatch(job);
      else pending = job;
    },
    complete(id: number, result: R) {
      if (id !== active) return;
      active = null;
      if (id === newest) commit(result);
      if (pending) {
        const job = pending;
        pending = null;
        dispatch(job);
      }
    },
  };
}
