import { catalogInitials } from "@fabdesk/protocol";
import { useEffect, useState } from "react";
import { cn } from "../util";

/** Catalog thumbnail with an initials tile if `src` is missing or the image fails to load. */
export function CatalogThumb({
  src,
  name,
  className,
}: {
  src?: string;
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 font-medium uppercase tracking-wide text-muted",
          className,
        )}
        aria-hidden
      >
        {catalogInitials(name)}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      className={cn("shrink-0 rounded-md border border-border bg-panel-2 object-cover", className)}
      onError={() => setFailed(true)}
    />
  );
}
