import type { FileEntry, OrderReadiness, OrderSession, OrderVendorId } from "@fabdesk/protocol";

export function assessOrderReadiness(files: readonly Pick<FileEntry, "path">[]): OrderReadiness {
  const hasGerbers = files.some((f) => f.path.startsWith("exports/gerbers/") || /gerber/i.test(f.path));
  const hasFabricationZip = files.some((f) => f.path === "exports/fabrication.zip" || (f.path.startsWith("exports/") && f.path.endsWith(".zip")));
  const hasRouted = files.some((f) => f.path === "circuit.routed.json");
  const hasKicadPcb = files.some((f) => f.path.endsWith(".kicad_pcb"));
  const ready = hasGerbers || hasFabricationZip || hasKicadPcb || hasRouted;
  const reasons: string[] = [];
  if (!hasKicadPcb && !hasRouted && !hasGerbers && !hasFabricationZip) {
    reasons.push("Add a routed board or KiCad PCB, then export gerbers before ordering.");
  } else if (!hasGerbers && !hasFabricationZip) {
    reasons.push("Export gerbers or a fabrication zip to send to a fab house.");
  }
  return { ready, hasGerbers, hasFabricationZip, hasRouted, hasKicadPcb, reasons };
}

const VENDORS: Record<OrderVendorId, { label: string; enabled: boolean; orderUrl?: string }> = {
  jlcpcb: { label: "JLCPCB", enabled: true, orderUrl: "https://cart.jlcpcb.com/quote" },
  pcbway: { label: "PCBWay", enabled: true, orderUrl: "https://www.pcbway.com/orderonline.aspx" },
  laser: { label: "Laser", enabled: false },
  cnc: { label: "CNC", enabled: false },
};

export function orderVendors(): Array<{ id: OrderVendorId; label: string; enabled: boolean }> {
  return (Object.entries(VENDORS) as Array<[OrderVendorId, (typeof VENDORS)[OrderVendorId]]>).map(([id, v]) => ({
    id,
    label: v.label,
    enabled: v.enabled,
  }));
}

export function startOrderSession(vendor: OrderVendorId): OrderSession {
  const info = VENDORS[vendor];
  if (!info.enabled) {
    return {
      vendor,
      label: info.label,
      enabled: false,
      steps: [{ title: "Coming later", body: `${info.label} ordering is not available yet.` }],
    };
  }
  return {
    vendor,
    label: info.label,
    enabled: true,
    ...(info.orderUrl ? { orderUrl: info.orderUrl } : {}),
    steps: [
      {
        title: "Export fabrication files",
        body: "Use export_zip (or export_gerbers + export_drill) so exports/fabrication.zip is ready to upload.",
      },
      {
        title: `Open ${info.label}`,
        body: `Create a PCB order on ${info.label} and upload the fabrication zip. Fabdesk does not place the order for you.`,
      },
      {
        title: "Check the quote",
        body: "Confirm layers, thickness, surface finish, and quantity on the fab house quote before paying.",
      },
    ],
  };
}
