import {reservedConflicts,areaObstacle,netWeight} from './constraints';
import {clone,worldPoint} from './pcb';
import {collide,polygons,bounds,boardConflict,boardContours,inside,edges,rectangular,outlineContours,polygonDistance} from './geometry';
const round=n=>Math.round(n*10000)/10000;
export function units(s){const map=new Map();for(const p of s.parts){const id=p.group?'group:'+p.group:p.id;const u=map.get(id)||{id,parts:[]};u.parts.push(p);map.set(id,u);}return [...map.values()];}
export function expanded(s,ids){const set=new Set(ids);return units(s).filter(u=>u.parts.some(p=>set.has(p.id))).flatMap(u=>u.parts.map(p=>p.id));}
const center=u=>({x:u.parts.reduce((n,p)=>n+p.x,0)/u.parts.length,y:u.parts.reduce((n,p)=>n+p.y,0)/u.parts.length});
const shift=(u,dx,dy)=>{for(const p of u.parts){p.x=round(p.x+dx);p.y=round(p.y+dy);}};
const axes=(u,fixed=new Set())=>({x:!u.parts.some(p=>p.locked||fixed.has(p.id)||['left','right'].includes(p.anchor?.edge)),y:!u.parts.some(p=>p.locked||fixed.has(p.id)||['top','bottom'].includes(p.anchor?.edge))});
const unitCollision=(u,v,c)=>u.parts.some(p=>v.parts.some(q=>collide(p,q,c)));
const poses=s=>s.parts.map(p=>[p.x,p.y,p.angle]);
const restore=(s,ps)=>s.parts.forEach((p,i)=>{[p.x,p.y,p.angle]=ps[i];});
export function issues(s){const result=[],c=0;const loops=boardContours(s);if(s.contourRoles)for(let i=0;i<loops.length;i++)if(s.contourRoles[i]==='hole'&&!loops.some((outer,j)=>s.contourRoles[j]==='outer'&&loops[i].every(p=>inside(p,outer,false))))result.push({ids:[],kind:'outline',text:'A cutout no longer fits inside the outer board contour.'});for(const a of s.reservedAreas||[])if(a.x<s.board.x||a.y<s.board.y||a.x+a.w>s.board.x+s.board.w||a.y+a.h>s.board.y+s.board.h)result.push({ids:[],areaId:a.id,kind:'reserved-boundary',text:`Reserved area ${a.name} extends beyond the board bounds`});const topology=!s.contours&&!s.outlineInferred?outlineContours(s.outline):null;if(topology?.open||!boardContours(s).length)result.push({ids:[],kind:'outline',text:'Board outline is open or unsupported; close Edge.Cuts before relying on edge checks.'});for(let i=0;i<s.parts.length;i++){const p=s.parts[i],bad=boardConflict(s,p);if(bad)result.push({ids:[p.id],kind:'edge',text:`${p.ref} ${bad}`});for(const area of reservedConflicts(s,p))result.push({ids:[p.id],areaId:area.id,kind:'reserved',text:`${p.ref} enters reserved area ${area.name} or its margin`});if(p.anchor){const axis=['left','right'].includes(p.anchor.edge)?'x':'y';if(Math.abs(p[axis]-anchorTarget(s.board,p.anchor))>.005)result.push({ids:[p.id],kind:'anchor',text:`${p.ref} cannot satisfy its ${p.anchor.edge} anchor`});}if(p.overhang&&!rectangular(s))result.push({ids:[p.id],kind:'overhang',text:`${p.ref}: edge overhang requires a rectangular outer contour`});for(let j=i+1;j<s.parts.length;j++){const q=s.parts[j];if(collide(p,q,c))result.push({ids:[p.id,q.id],kind:'overlap',text:`${p.ref} courtyard overlaps ${q.ref}`});}}return result;}
export function anchorTarget(b,a){return (a.edge==='left'?b.x:a.edge==='right'?b.x+b.w:a.edge==='top'?b.y:b.y+b.h)+a.offset;}
export function setAnchor(s,p,edge){if(!edge){delete p.anchor;p.overhang=false;return;}if(!['left','right','top','bottom'].includes(edge))throw Error('Invalid anchor edge.');const axis=['left','right'].includes(edge)?'x':'y',base=anchorTarget(s.board,{edge,offset:0});p.anchor={edge,offset:round(p[axis]-base)};}
export function moveParts(s,ids,dx,dy){const set=new Set(expanded(s,ids));for(const u of units(s).filter(u=>u.parts.some(p=>set.has(p.id)))){const a=axes(u);shift(u,a.x?dx:0,a.y?dy:0);}return [...set];}
export function rotateParts(s,ids,degrees=90){const set=new Set(expanded(s,ids)),us=units(s).filter(u=>u.parts.some(p=>set.has(p.id)));if(us.some(u=>u.parts.some(p=>p.locked||p.anchor)))throw Error('Unlock and unanchor selected groups before rotating.');const parts=us.flatMap(u=>u.parts),c=center({parts}),a=-degrees*Math.PI/180;for(const p of parts){const x=p.x-c.x,y=p.y-c.y;p.x=round(c.x+x*Math.cos(a)-y*Math.sin(a));p.y=round(c.y+x*Math.sin(a)+y*Math.cos(a));p.angle=round((p.angle+degrees)%360);}}
export function groupParts(s,ids){const set=new Set(expanded(s,ids));if(set.size<2)throw Error('Select at least two parts.');const group=crypto.randomUUID();for(const p of s.parts)if(set.has(p.id))p.group=group;return group;}
export function ungroupParts(s,ids){const set=new Set(expanded(s,ids));for(const p of s.parts)if(set.has(p.id))delete p.group;}
export function alignParts(s,ids,mode){const set=new Set(expanded(s,ids)),us=units(s).filter(u=>u.parts.some(p=>set.has(p.id)));if(us.length<2)throw Error('Select at least two independent parts or groups.');const axis=mode.endsWith('x')?'x':'y';if(us.some(u=>!axes(u)[axis]))throw Error('A lock or edge anchor prevents this alignment.');const cs=us.map(center);if(mode.startsWith('distribute')){if(us.length<3)throw Error('Select at least three independent parts or groups.');const sorted=us.map((u,i)=>({u,c:cs[i]})).sort((a,b)=>a.c[axis]-b.c[axis]);const first=sorted[0].c[axis],last=sorted.at(-1).c[axis];sorted.forEach(({u,c},i)=>shift(u,axis==='x'?first+(last-first)*i/(sorted.length-1)-c.x:0,axis==='y'?first+(last-first)*i/(sorted.length-1)-c.y:0));}else{const target=cs.reduce((n,c)=>n+c[axis],0)/cs.length;us.forEach((u,i)=>shift(u,axis==='x'?target-cs[i].x:0,axis==='y'?target-cs[i].y:0));}}
function separations(p,q,c){const a=polygons(p).flat(),b=polygons(q).flat(),dirs=[[1,0],[0,1]];for(const poly of [...polygons(p),...polygons(q)])for(const [v,w] of edges(poly)){const dx=w[0]-v[0],dy=w[1]-v[1],len=Math.hypot(dx,dy);if(len>1e-6){const n=[-dy/len,dx/len];if(!dirs.some(d=>Math.abs(d[0]*n[0]+d[1]*n[1])>.999))dirs.push(n);}}const out=[];for(const d of dirs){const ap=a.map(p=>p[0]*d[0]+p[1]*d[1]),bp=b.map(p=>p[0]*d[0]+p[1]*d[1]);const low=Math.min(...ap)-Math.max(...bp)-c-.005,high=Math.max(...ap)-Math.min(...bp)+c+.005;out.push([d[0]*low,d[1]*low],[d[0]*high,d[1]*high]);}return out;}
function canShift(u,dx,dy,fixed){const a=axes(u,fixed);return (a.x||Math.abs(dx)<1e-6)&&(a.y||Math.abs(dy)<1e-6);}
const environmentCount=(s,p)=>(boardConflict(s,p)?1:0)+reservedConflicts(s,p).length;
function fitUnit(s,u,fixed){const a=axes(u,fixed);if(!a.x&&!a.y||!u.parts.some(p=>environmentCount(s,p)))return;const old=u.parts.map(p=>[p.x,p.y]),b=bounds(u.parts.flatMap(polygons)),edge=0;
const dx=Math.max(s.board.x+edge-b.minX,Math.min(0,s.board.x+s.board.w-edge-b.maxX)),dy=Math.max(s.board.y+edge-b.minY,Math.min(0,s.board.y+s.board.h-edge-b.maxY));const candidates=[[a.x?dx:0,a.y?dy:0]];for(const step of [.25,.5,1,2,4,8,16])for(const [x,y] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]])candidates.push([a.x?x*step:0,a.y?y*step:0]);for(const p of u.parts)for(const area of reservedConflicts(s,p))for(const [x,y] of separations(p,areaObstacle(area,p.side),area.margin))if((a.x||Math.abs(x)<1e-6)&&(a.y||Math.abs(y)<1e-6))candidates.push([x,y]);let best=null;for(const [x,y] of candidates){u.parts.forEach((p,i)=>{p.x=old[i][0]+x;p.y=old[i][1]+y;});const bad=u.parts.reduce((n,p)=>n+environmentCount(s,p),0),score=bad*10000+Math.hypot(x,y);if(!best||score<best.score)best={x,y,score,bad};}u.parts.forEach((p,i)=>{p.x=old[i][0];p.y=old[i][1];});if(best.bad<u.parts.reduce((n,p)=>n+environmentCount(s,p),0))shift(u,best.x,best.y);}
export function relax(s,{fixedIds=[],passes=60,activeOnly=false}={}){const fixed=new Set(expanded(s,fixedIds)),us=units(s),active=new Set(us.filter(u=>u.parts.some(p=>fixed.has(p.id))).map(u=>u.id)),start=poses(s);const started=performance.now(),budgetMs=activeOnly?30:400;let timedOut=false,best=poses(s),bestScore=Infinity;
const score=()=>{let n=0;for(const u of us){if(!activeOnly||active.has(u.id))n+=u.parts.reduce((n,p)=>n+environmentCount(s,p),0);for(const v of us)if(u.id<v.id&&(!activeOnly||active.has(u.id)||active.has(v.id))&&unitCollision(u,v,0))n++;}return n*100000+s.parts.reduce((sum,p,i)=>sum+Math.hypot(p.x-start[i][0],p.y-start[i][1]),0);};
search:for(let pass=0;pass<passes;pass++){for(const u of us)if(!activeOnly||active.has(u.id))fitUnit(s,u,fixed);let changed=false;for(let i=0;i<us.length;i++)for(let j=i+1;j<us.length;j++){if(performance.now()-started>budgetMs){timedOut=true;break search;}const u=us[i],v=us[j];if(activeOnly&&!active.has(u.id)&&!active.has(v.id))continue;const pair=u.parts.flatMap(p=>v.parts.filter(q=>collide(p,q,0)).map(q=>[p,q]))[0];if(!pair)continue;let choice=null;for(const [moving,other,p,q] of [[v,u,pair[0],pair[1]],[u,v,pair[1],pair[0]]])for(const [dx,dy] of separations(p,q,0)){if(!canShift(moving,dx,dy,fixed))continue;shift(moving,dx,dy);const still=unitCollision(moving,other,0),boundary=moving.parts.reduce((n,p)=>n+environmentCount(s,p),0),hard=us.filter(z=>z!==moving&&z!==other&&!axes(z,fixed).x&&!axes(z,fixed).y&&unitCollision(moving,z,0)).length,others=us.filter(z=>z!==moving&&z!==other&&unitCollision(moving,z,0)).length;const cost=(still?1e7:0)+boundary*1e6+hard*1e5+others*.4+Math.hypot(dx,dy);shift(moving,-dx,-dy);if(!choice||cost<choice.cost)choice={moving,dx,dy,cost};}if(choice&&choice.cost<1e6){shift(choice.moving,choice.dx,choice.dy);active.add(choice.moving.id);changed=true;}}const n=score();if(n<bestScore){bestScore=n;best=poses(s);}if(!changed)break;}
restore(s,best);return {timedOut,issues:issues(s),moved:s.parts.filter((p,i)=>Math.hypot(p.x-start[i][0],p.y-start[i][1])>.0001).map(p=>p.id)};}
export function shove(s,ids){return relax(s,{fixedIds:ids,passes:30,activeOnly:true});}
export function resizeBoard(s,w,h,adjust=true){if(!Number.isFinite(w)||!Number.isFinite(h)||w<5||h<5||w>2000||h>2000)throw Error('Board dimensions must be between 5 and 2000 mm.');const old={...s.board},loops=boardContours(s);if(!loops.length||(!s.contours&&!s.outlineInferred&&outlineContours(s.outline).open))throw Error('Close the board outline before resizing.');s.contourRoles??=loops.map((poly,i)=>loops.filter((q,j)=>i!==j&&inside(poly[0],q,false)).length%2?'hole':'outer');s.contours=loops.map((poly,i)=>{const depth=s.contourRoles[i]==='hole'?1:0;if(depth%2===0)return poly.map(([x,y])=>[round(old.x+(x-old.x)*w/old.w),round(old.y+(y-old.y)*h/old.h)]);const c={x:poly.reduce((n,p)=>n+p[0],0)/poly.length,y:poly.reduce((n,p)=>n+p[1],0)/poly.length},dx=(c.x-old.x)*(w/old.w-1),dy=(c.y-old.y)*(h/old.h-1);return poly.map(([x,y])=>[round(x+dx),round(y+dy)]);});s.board.w=round(w);s.board.h=round(h);s.resized=true;if(adjust){for(const u of units(s)){if(u.parts.some(p=>p.locked))continue;const c=center(u);let dx=(c.x-old.x)*(w/old.w-1),dy=(c.y-old.y)*(h/old.h-1);for(const p of u.parts)if(p.anchor){const axis=['left','right'].includes(p.anchor.edge)?'x':'y';if(axis==='x')dx=anchorTarget(s.board,p.anchor)-p.x;else dy=anchorTarget(s.board,p.anchor)-p.y;}shift(u,dx,dy);}relax(s);}return issues(s);}
export function netEdges(s,filter=''){const nets=new Map();for(const p of s.parts)for(const pad of p.pads)if(pad.net&&pad.net!=='0'&&(!filter||filter===pad.net)){const list=nets.get(pad.net)||[];list.push({id:p.id,xy:worldPoint(p,pad.x,pad.y)});nets.set(pad.net,list);}const out=[];for(const [name,pts] of nets){if(pts.length<2)continue;const dist=pts.map(()=>Infinity),parent=pts.map(()=>0),used=new Set();dist[0]=0;for(let k=0;k<pts.length;k++){let idx=-1;for(let i=0;i<pts.length;i++)if(!used.has(i)&&(idx<0||dist[i]<dist[idx]))idx=i;if(idx<0)break;used.add(idx);if(k>0&&pts[idx].id!==pts[parent[idx]].id)out.push({name,a:pts[parent[idx]],b:pts[idx],length:dist[idx]});for(let j=0;j<pts.length;j++)if(!used.has(j)){const d=pts[idx].id===pts[j].id?0:Math.hypot(pts[idx].xy[0]-pts[j].xy[0],pts[idx].xy[1]-pts[j].xy[1]);if(d<dist[j]){dist[j]=d;parent[j]=idx;}}}}return out;}
export const connectionLength=s=>netEdges(s).reduce((n,e)=>n+e.length,0);
export const placementScore=s=>netEdges(s).reduce((n,e)=>n+e.length*netWeight(s,e.name),0);
const issueKey=i=>i.kind+':'+[...i.ids].sort().join(',')+':'+(i.areaId||'');

// A preview stays feasible throughout the search. Existing findings may be repaired,
// but a repaired finding cannot be reintroduced by a later move.
export function suggestPlacement(s,ids=[],{budgetMs=1500,maxSweeps=8,allowRotation=true}={}){
  const candidate=clone(s),before=connectionLength(s),beforeScore=placementScore(s),set=new Set(expanded(candidate,ids));
  const us=units(candidate).filter(u=>!set.size||u.parts.some(p=>set.has(p.id)));
  let current=beforeScore,allowed=new Set(issues(candidate).map(issueKey)),evaluated=0,accepted=0,sweeps=0,timedOut=false;
  const started=performance.now(),span=Math.max(s.board.w,s.board.h);
  const steps=[...new Set([Math.min(10,Math.max(2,span/8)),2,1,.5,.25])].sort((a,b)=>b-a);
  const save=u=>u.parts.map(p=>[p.x,p.y,p.angle]);
  const reset=(u,ps)=>u.parts.forEach((p,i)=>{[p.x,p.y,p.angle]=ps[i];});
  search:for(const step of steps){
    for(let sweep=0;sweep<maxSweeps;sweep++){
      let changed=false;sweeps++;
      for(const u of us){
        const a=axes(u);if(!a.x&&!a.y)continue;
        const original=save(u);let best=null;
        const trials=[[step,0,0],[-step,0,0],[0,step,0],[0,-step,0],[step,step,0],[-step,step,0],[step,-step,0],[-step,-step,0]];
        if(allowRotation&&!u.parts.some(p=>p.anchor||p.locked))for(const angle of [90,180,270])trials.push([0,0,angle]);
        for(const [dx,dy,angle] of trials){
          if(performance.now()-started>=budgetMs){timedOut=true;break search;}
          if((!a.x&&dx)||(!a.y&&dy))continue;
          reset(u,original);if(angle)rotateParts(candidate,u.parts.map(p=>p.id),angle);else shift(u,dx,dy);
          evaluated++;
          const findings=issues(candidate);
          if(!findings.some(i=>!allowed.has(issueKey(i)))){
            const length=placementScore(candidate);
            if(length<(best?.length??current)-.001)best={poses:save(u),length,allowed:new Set(findings.map(issueKey))};
          }
          reset(u,original);
        }
        if(best){reset(u,best.poses);current=best.length;allowed=best.allowed;accepted++;changed=true;}
      }
      if(!changed)break;
    }
  }
  // A timeout may occur before a trial is restored; only committed improvements survive.
  // Every trial checks time before mutating, and restores immediately after evaluation.
  return {candidate,before,after:connectionLength(candidate),beforeScore,afterScore:placementScore(candidate),timedOut,evaluated,accepted,sweeps};
}

// Axis-aligned envelope spacing respects actual rotated group extents, not pad origins.
export function spaceParts(s,ids,axis,gap){
  if(!['x','y'].includes(axis)||!Number.isFinite(gap)||gap<0||gap>100)throw Error('Gap must be between 0 and 100 mm.');
  const set=new Set(expanded(s,ids)),us=units(s).filter(u=>u.parts.some(p=>set.has(p.id)));
  if(us.length<2)throw Error('Select at least two independent parts or groups.');
  const key=axis==='x'?'minX':'minY',end=axis==='x'?'maxX':'maxY';
  const sorted=us.map(u=>({u,b:bounds(u.parts.flatMap(polygons))})).sort((a,b)=>a.b[key]-b.b[key]);
  let cursor=sorted[0].b[end];const shifts=[];
  for(const {u,b} of sorted.slice(1)){
    const delta=cursor+gap-b[key];
    if(Math.abs(delta)>.0001&&!axes(u)[axis])throw Error('A lock or edge anchor prevents this spacing.');
    shifts.push({u,delta});cursor=b[end]+delta;
  }
  // Compute all moves before writing so constraint failures leave the model unchanged.
  for(const {u,delta} of shifts)shift(u,axis==='x'?delta:0,axis==='y'?delta:0);
}

// User-chosen targets are advisory only. They never enter issues(), shove,
// spreading, suggestion feasibility or the search objective.
export function spacingGuidelines(s){
  const settings=s.spacingGuidelines;if(!settings?.enabled)return [];
  const out=[];
  for(let i=0;i<s.parts.length;i++){
    const p=s.parts[i];
    if(settings.edge>0&&!boardConflict(s,p)&&boardConflict(s,p,settings.edge))out.push({kind:'edge-guideline',ids:[p.id],targetMm:settings.edge,text:`${p.ref}: envelope is within your ${settings.edge} mm edge target`});
    if(settings.courtyard>0)for(const q of s.parts.slice(i+1))if(!collide(p,q,0)&&collide(p,q,settings.courtyard)){
      const gap=Math.min(...polygons(p).flatMap(a=>polygons(q).map(b=>polygonDistance(a,b))));
      out.push({kind:'spacing-guideline',ids:[p.id,q.id],gapMm:gap,targetMm:settings.courtyard,text:`${p.ref} / ${q.ref}: ${Number(gap.toFixed(3))} mm courtyard gap · your target ${settings.courtyard} mm`});
    }
  }
  return out;
}
