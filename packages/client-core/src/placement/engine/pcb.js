import {validatePlacementSettings} from './constraints';
import {footprintContours, bounds as polygonBounds, boardContours, path as contourPath} from './geometry';
// Dependency-free KiCad placement model. Native input stays in its own syntax tree.
export const clone = x => structuredClone(x);
export const val = x => typeof x === 'string' && x.startsWith('"') ? JSON.parse(x) : String(x ?? '');
export const child = (n, key) => n.find(x => Array.isArray(x) && x[0] === key);
export const children = (n, key) => n.filter(x => Array.isArray(x) && x[0] === key);
export const num = (n, key, i=1, fallback=0) => Number(child(n,key)?.[i] ?? fallback);
export function parse(text) {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g) || [];
  let i=0;
  function read(depth=0) {
    if(depth>150) throw Error('File nesting is too deep.');
    if(tokens[i++] !== '(') throw Error('Expected a KiCad S-expression.');
    const n=[];
    while(i<tokens.length && tokens[i]!==')') n.push(tokens[i]==='('?read(depth+1):tokens[i++]);
    if(tokens[i++]!==')') throw Error('Incomplete KiCad file.');
    return n;
  }
  const root=read();
  if(i!==tokens.length) throw Error('Unexpected content after KiCad document.');
  return root;
}
export function serialize(n, depth=0) {
  if(!Array.isArray(n)) return String(n);
  return '('+n.map((x,i)=>Array.isArray(x)?'\n'+'  '.repeat(depth+1)+serialize(x,depth+1):(i?' ':'')+x).join('')+')';
}
const q = s => JSON.stringify(String(s));
const pose = n => {const t=child(n,'transform');return t?{x:num(t,'translate'),y:num(t,'translate',2),angle:num(t,'rotate')}:{x:num(n,'at'),y:num(n,'at',2),angle:num(n,'at',3)};};
function set(n,key,values) {const x=child(n,key);if(x)x.splice(1,x.length-1,...values);else n.push([key,...values]);}
const round = n => Math.round(n*10000)/10000;
export function geometry(node) {
  const {angle}=pose(node);
  const pads=children(node,'pad').map(p=>({number:val(p[1]),type:p[2],shape:p[3],x:num(p,'at'),y:num(p,'at',2),angle:num(p,'at',3)-angle,w:num(p,'size',1,1),h:num(p,'size',2,1),drill:num(p,'drill'),net:val(child(p,'net')?.at(-1)),node:p}));
  const shapes=node.filter(n=>Array.isArray(n)&&['fp_line','fp_rect','fp_circle','fp_poly','fp_arc'].includes(n[0])).map(n=>({type:n[0],layer:val(child(n,'layer')?.[1]),start:n[0]==='fp_circle'?[num(n,'center'),num(n,'center',2)]:[num(n,'start'),num(n,'start',2)],end:[num(n,'end'),num(n,'end',2)],mid:[num(n,'mid'),num(n,'mid',2)],points:children(child(n,'pts')||[],'xy').map(p=>[+p[1],+p[2]])}));
  let points=[];
  const courtyard=shapes.filter(s=>s.layer.endsWith('CrtYd'));
  for(const s of courtyard.length?courtyard:shapes.filter(s=>s.layer.endsWith('Fab'))) points.push(...(s.type==='fp_poly'?s.points:[s.start,s.end]));
  for(const p of pads) {
    const a=p.angle*Math.PI/180, w=Math.abs(Math.cos(a))*p.w+Math.abs(Math.sin(a))*p.h,h=Math.abs(Math.sin(a))*p.w+Math.abs(Math.cos(a))*p.h;
    points.push([p.x-w/2,p.y-h/2],[p.x+w/2,p.y+h/2]);
  }
  if(!points.length)points=[[-1,-1],[1,1]];
  const bounds={minX:Math.min(...points.map(p=>p[0])),minY:Math.min(...points.map(p=>p[1])),maxX:Math.max(...points.map(p=>p[0])),maxY:Math.max(...points.map(p=>p[1]))};
  const detailed=footprintContours(node,pads,bounds);
  return {pads,shapes,...detailed,bounds:polygonBounds(detailed.contours)};
}
export function partFromNode(node,index) {
  const prop=k=>val(children(node,'property').find(p=>val(p[1])===k)?.[2]);
  const ref=prop('Reference')||val(children(node,'fp_text').find(p=>p[1]==='reference')?.[2])||`FP${index+1}`;
  const position=pose(node);
  return {id:String(index),ref,value:prop('Value')||val(children(node,'fp_text').find(p=>p[1]==='value')?.[2]),footprint:val(node[1]),...position,originalAngle:position.angle,side:val(child(node,'layer')?.[1]).startsWith('B.')?'B':'F',locked:node.includes('locked')||val(child(node,'locked')?.[1])==='yes',node, ...geometry(node)};
}
export function importBoard(text,name='board.kicad_pcb') {
  const root=parse(text);
  if(root[0]!=='kicad_pcb')throw Error('Open a .kicad_pcb board, or a saved Placement Lab JSON.');
  const parts=children(root,'footprint').map(partFromNode);
  if(!parts.length)throw Error('No footprints found. Legacy module boards are not supported.');
  const edge=root.filter(n=>Array.isArray(n)&&val(child(n,'layer')?.[1])==='Edge.Cuts');
  const points=[];
  for(const e of edge) {
    if(e[0]==='gr_circle') {const x=num(e,'center'),y=num(e,'center',2),r=Math.hypot(num(e,'end')-x,num(e,'end',2)-y);points.push([x-r,y-r],[x+r,y+r]);}
    else if(e[0]==='gr_arc') {const a=[num(e,'start'),num(e,'start',2)],b=[num(e,'mid'),num(e,'mid',2)],c=[num(e,'end'),num(e,'end',2)];points.push(...arcPoints(a,b,c));}
    else if(e[0]==='gr_poly')points.push(...children(child(e,'pts')||[],'xy').map(p=>[+p[1],+p[2]]));
    else points.push([num(e,'start'),num(e,'start',2)],[num(e,'end'),num(e,'end',2)]);
  }
  if(!points.length)for(const p of parts){const b=worldBounds(p);points.push([b.minX-3,b.minY-3],[b.maxX+3,b.maxY+3]);}
  const x=Math.min(...points.map(p=>p[0])),y=Math.min(...points.map(p=>p[1]));
  return {schema:'placement-lab/v5',clearance:0,edgeClearance:0,spacingGuidelines:{enabled:false,courtyard:0,edge:0},name:name.replace(/\.[^.]+$/,''),root,parts,board:{x,y,w:Math.max(1,Math.max(...points.map(p=>p[0]))-x),h:Math.max(1,Math.max(...points.map(p=>p[1]))-y)},outline:edge,resized:false,outlineInferred:!edge.length};
}
export function arcPoints(a,b,c) {
  const d=2*(a[0]*(b[1]-c[1])+b[0]*(c[1]-a[1])+c[0]*(a[1]-b[1]));
  if(Math.abs(d)<1e-8)return [a,b,c];
  const s=p=>p[0]**2+p[1]**2;
  const x=(s(a)*(b[1]-c[1])+s(b)*(c[1]-a[1])+s(c)*(a[1]-b[1]))/d,y=(s(a)*(c[0]-b[0])+s(b)*(a[0]-c[0])+s(c)*(b[0]-a[0]))/d;
  const tau=Math.PI*2,ang=p=>Math.atan2(p[1]-y,p[0]-x),norm=v=>(v%tau+tau)%tau;
  let sweep=norm(ang(c)-ang(a));if(norm(ang(b)-ang(a))>sweep)sweep-=tau;
  const r=Math.hypot(a[0]-x,a[1]-y);
  const count=Math.max(12,Math.ceil(Math.abs(sweep)*16));
  return Array.from({length:count+1},(_,i)=>[x+r*Math.cos(ang(a)+sweep*i/count),y+r*Math.sin(ang(a)+sweep*i/count)]);
}
export function worldPoint(p,x,y) {const a=-p.angle*Math.PI/180;return [p.x+x*Math.cos(a)-y*Math.sin(a),p.y+x*Math.sin(a)+y*Math.cos(a)];}
export const boardPath=state=>contourPath(boardContours(state));
export function worldBounds(p) {const b=p.bounds,pts=[[b.minX,b.minY],[b.maxX,b.minY],[b.maxX,b.maxY],[b.minX,b.maxY]].map(v=>worldPoint(p,...v));return {minX:Math.min(...pts.map(v=>v[0])),minY:Math.min(...pts.map(v=>v[1])),maxX:Math.max(...pts.map(v=>v[0])),maxY:Math.max(...pts.map(v=>v[1]))};}
const electricalPads=n=>children(n,'pad').filter(p=>p[2]!=='np_thru_hole'&&val(p[1])!=='');
export function replaceFootprint(p,text,name) {
  if(p.locked)throw Error('Unlock this part before replacing its footprint.');

  const n=parse(text);if(n[0]!=='footprint')throw Error('Choose a .kicad_mod footprint.');
  if(p.side==='B')mirrorBack(n);
  const oldPads=electricalPads(p.node),newPads=electricalPads(n),keys=ps=>[...new Set(ps.map(p=>val(p[1])))].sort().join('|');
  if(keys(oldPads)!==keys(newPads))throw Error('Pad numbers differ. Choose a footprint with the same numbered pads; pin remapping is not supported.');
  const nets=new Map();
  for(const pad of oldPads) {const key=val(pad[1]),net=child(pad,'net');if(nets.has(key)&&JSON.stringify(nets.get(key))!==JSON.stringify(net))throw Error('Duplicate pad number has conflicting nets.');nets.set(key,clone(net));}
  for(const pad of newPads){const net=nets.get(val(pad[1]));if(net)pad.push(clone(net));}
  const oldProps=children(p.node,'property');
  for(const prop of oldProps)if(['Reference','Value','Datasheet','Description'].includes(val(prop[1]))) {const target=children(n,'property').find(x=>val(x[1])===val(prop[1]));if(target)target[2]=prop[2];else n.push(clone(prop));}
  for(const key of ['uuid','path','sheetname','sheetfile']) {const data=child(p.node,key);if(data){const index=n.findIndex(x=>Array.isArray(x)&&x[0]===key);if(index>=0)n.splice(index,1);n.push(clone(data));}}
  function freshIds(node,root=true){for(const x of node)if(Array.isArray(x)){if(x[0]==='uuid'&&!root)x[1]=q(crypto.randomUUID());else freshIds(x,false);}}
  freshIds(n);
  // Library geometry starts at 0 degrees. Export rotates pad-local orientations later.
  set(n,'at',['0','0','0']);n[1]=q(name||val(n[1]));
  Object.assign(p,{node:n,footprint:val(n[1]),originalAngle:0,...geometry(n)});
}
export function exportBoard(state) {
  const root=clone(state.root).filter(n=>!Array.isArray(n)||!['footprint','segment','arc','via','zone','group','generated'].includes(n[0]));
  if(state.resized) {
    for(let i=root.length-1;i>=0;i--)if(Array.isArray(root[i])&&val(child(root[i],'layer')?.[1])==='Edge.Cuts')root.splice(i,1);
    for(const loop of boardContours(state))for(let i=0;i<loop.length;i++) {const a=loop[i],b=loop[(i+1)%loop.length];root.push(['gr_line',['start',...a.map(x=>String(round(x)))],['end',...b.map(x=>String(round(x)))],['stroke',['width','0.05'],['type','default']],['layer',q('Edge.Cuts')],['uuid',q(crypto.randomUUID())]]);}

  }
  for(const p of state.parts) {
    const n=clone(p.node),delta=p.angle-p.originalAngle;
    const transform=child(n,'transform');
    if(transform){set(transform,'translate',[String(round(p.x)),String(round(p.y))]);set(transform,'rotate',[String(round(p.angle))]);}
    else if(Number(child(state.root,'version')?.[1])>=20260901){set(n,'transform',[['translate',String(round(p.x)),String(round(p.y))],['rotate',String(round(p.angle))],['scale','1','1']]);const at=child(n,'at');if(at)n.splice(n.indexOf(at),1);}
    else set(n,'at',[String(round(p.x)),String(round(p.y)),String(round(p.angle))]);
    const locked=child(n,'locked');if(locked)n.splice(n.indexOf(locked),1);const token=n.indexOf('locked');if(token>=0)n.splice(token,1);if(p.locked)n.push(['locked','yes']);
    for(const pad of children(n,'pad')) {const at=child(pad,'at')||['at','0','0'];set(pad,'at',[at[1],at[2],String(round(Number(at[3]||0)+delta))]);}
    // Filled footprint zones would also contain obsolete copper after moving.
    for(let i=n.length-1;i>=0;i--)if(Array.isArray(n[i])&&n[i][0]==='zone')n.splice(i,1);
    root.push(n);
  }
  return serialize(root)+'\n';
}
export function loadSession(text) {
  const s=JSON.parse(text);
  if(!['placement-lab/v1','placement-lab/v2','placement-lab/v4','placement-lab/v5'].includes(s.schema)||!Array.isArray(s.root)||s.root[0]!=='kicad_pcb'||!Array.isArray(s.parts)||s.parts.length>10000)throw Error('Not a Placement Lab session.');
  for(const p of s.parts)if(!Array.isArray(p.node)||p.node[0]!=='footprint'||![p.x,p.y,p.angle].every(Number.isFinite))throw Error('Invalid part in session.');
  if(!s.board||![s.board.x,s.board.y,s.board.w,s.board.h].every(Number.isFinite)||s.board.w<=0||s.board.h<=0)throw Error('Invalid board in session.');
  if(new Set(s.parts.map(p=>p.id)).size!==s.parts.length)throw Error('Duplicate part IDs.');
  for(const p of s.parts){
    if(!['F','B'].includes(p.side)||typeof p.id!=='string'||p.group&&typeof p.group!=='string')throw Error('Invalid part metadata.');
    if(p.anchor&&(!['left','right','top','bottom'].includes(p.anchor.edge)||!Number.isFinite(p.anchor.offset)))throw Error('Invalid anchor.');
    Object.assign(p,geometry(p.node));
  }
  if(s.contours&&(!Array.isArray(s.contours)||!s.contours.length||s.contours.some(l=>!Array.isArray(l)||l.length<3||l.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)))))throw Error('Invalid outline contours.');
  if(s.contourRoles&&(!s.contours||s.contourRoles.length!==s.contours.length||s.contourRoles.some(r=>!['hole','outer'].includes(r))))throw Error('Invalid contour roles.');
  for(const key of ['clearance','edgeClearance'])if(s[key]!==undefined&&(!Number.isFinite(s[key])||s[key]<0||s[key]>10))throw Error('Invalid clearance.');
  // Legacy margins become disabled advisory preferences, never geometric constraints.
  if(s.schema!=='placement-lab/v5')s.spacingGuidelines={enabled:false,courtyard:s.clearance??0,edge:s.edgeClearance??0};
  s.spacingGuidelines??={enabled:false,courtyard:0,edge:0};
  validatePlacementSettings(s);s.schema='placement-lab/v5';s.clearance=0;s.edgeClearance=0;
  return s;
}

// KiCad back-side footprints store mirrored local Y geometry and reversed local angles.
function mirrorBack(n){
  function visit(node){for(const c of node)if(Array.isArray(c)){
    if(['layer','layers'].includes(c[0]))for(let i=1;i<c.length;i++)if(typeof c[i]==='string'&&/^"F\./.test(c[i]))c[i]=c[i].replace('"F.','"B.');
    if(['at','start','end','center','mid','xy'].includes(c[0])&&Number.isFinite(Number(c[2]))){c[2]=String(-Number(c[2]));if(c[0]==='at'&&c[3]!==undefined)c[3]=String(-Number(c[3]));}
    if(c[0]==='effects'){let j=child(c,'justify');if(!j){j=['justify'];c.push(j);}if(!j.includes('mirror'))j.push('mirror');}
    visit(c);
  }}visit(n);
}
export function replacementPreview(p,text,name){const candidate=clone(p);candidate.locked=false;let error=null;try{replaceFootprint(candidate,text,name);}catch(e){error=e.message;const n=parse(text);if(n[0]!=='footprint')throw e;if(p.side==='B')mirrorBack(n);set(n,'at',['0','0','0']);Object.assign(candidate,{node:n,footprint:name,originalAngle:0,...geometry(n)});}return {candidate,error,compatible:!error,pads:electricalPads(p.node).map(n=>({number:val(n[1]),net:val(child(n,'net')?.at(-1))})),oldSize:[p.bounds.maxX-p.bounds.minX,p.bounds.maxY-p.bounds.minY],newSize:[candidate.bounds.maxX-candidate.bounds.minX,candidate.bounds.maxY-candidate.bounds.minY]};}

export function renewFootprintIds(node){for(const n of node)if(Array.isArray(n)){if(n[0]==='uuid')n[1]=q(crypto.randomUUID());else renewFootprintIds(n);}if(!child(node,'uuid')&&node[0]==='footprint')node.push(['uuid',q(crypto.randomUUID())]);}
