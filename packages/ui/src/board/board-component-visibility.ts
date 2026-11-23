import { Mesh, type Object3D } from "three";

/** Hide only component meshes in a recognized native PCB export. Keep the board
 * hierarchy, copper, ink, mask, authored visibility and all model bytes intact. */
export class BoardComponentVisibility {
  private components: { mesh: Mesh; visible: boolean }[] = [];
  constructor(root: Object3D) {
    let hasBoard = false;
    root.traverse(object => { if (object instanceof Mesh && object.userData["nativeBoardSurface"] === "board_PCB") hasBoard = true; });
    if (!hasBoard) return;
    root.traverse(object => {
      if (object instanceof Mesh && !object.userData["nativeBoardSurface"]) this.components.push({ mesh: object, visible: object.visible });
    });
  }
  setAssembled(assembled: boolean) {
    for (const { mesh, visible } of this.components) mesh.visible = assembled && visible;
  }
}

/** Three's raycaster also hits invisible meshes; hidden parts must not occlude
 * or select through the bare-board display. */
export function modelObjectVisible(object: Object3D): boolean {
  for (let node: Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}
