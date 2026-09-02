/**
 * `@tscircuit/fanout-solver` publishes raw TypeScript as its types, which does not compile under
 * this repo's `exactOptionalPropertyTypes`. The capacity-autorouter declarations import three
 * names from it; this stub (mapped in tsconfig `paths`) stands in for them at typecheck time only.
 */
declare module "@tscircuit/fanout-solver" {
  export type FanoutSolverOptions = Record<string, unknown>;
  export type FanoutSolverOutput = Record<string, unknown>;
  export class FanoutSolver {
    constructor(...args: unknown[]);
  }
}
