declare module "*.css";

declare module "*?url" { const url: string; export default url; }
declare module "*?worker&inline" {
  const WorkerConstructor: new (options?: WorkerOptions) => Worker;
  export default WorkerConstructor;
}
