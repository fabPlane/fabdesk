import { findOpenCatalogArg, type OpenCatalogIntent } from "@fabdesk/protocol";

/** Queues a catalog deep link until the renderer is ready to show it. */
export class OpenCatalogQueue {
  #pending: OpenCatalogIntent | null = null;

  offer(raw: string | readonly string[]): OpenCatalogIntent | null {
    const intent = typeof raw === "string" ? findOpenCatalogArg([raw]) : findOpenCatalogArg(raw);
    if (!intent) return null;
    this.#pending = intent;
    return intent;
  }

  peek(): OpenCatalogIntent | null {
    return this.#pending;
  }

  take(): OpenCatalogIntent | null {
    const intent = this.#pending;
    this.#pending = null;
    return intent;
  }
}
