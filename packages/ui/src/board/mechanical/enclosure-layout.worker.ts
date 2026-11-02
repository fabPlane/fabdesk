import { proposeEnclosureLayout, type LayoutBoard } from "@fabdesk/client-core/enclosure-layout";
import type { MechanicalDesign } from "@fabdesk/protocol";
import type { LayoutChoice } from "./EnclosureLayoutPanel";
const scope = self as unknown as {
  onmessage: (event: MessageEvent<{ design: MechanicalDesign; boards: LayoutBoard[] }>) => void;
  postMessage: (result: LayoutChoice[]) => void;
};
scope.onmessage = ({ data }) =>
  scope.postMessage(
    (["compact", "assembly", "ports"] as const).map((goal) => {
      try {
        return { goal, proposal: proposeEnclosureLayout(data.design, data.boards, goal) };
      } catch (error) {
        return { goal, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
