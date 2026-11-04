import {collide,polygons,bounds,edges} from "./geometry";
import {issues} from './placement';
import {worldPoint} from './pcb';

const key=i=>i.kind+':'+[...i.ids].sort().join(',')+':'+(i.areaId||'');
export function reviewPlacement(before,after){
  const old=new Map(before.parts.map(p=>[p.id,p])),a=issues(before),b=issues(after);
  const ak=new Set(a.map(key)),bk=new Set(b.map(key));
  return {
    changed:after.parts.filter(p=>{const q=old.get(p.id);return !q||Math.abs(p.x-q.x)>.0001||Math.abs(p.y-q.y)>.0001||Math.abs(p.angle-q.angle)>.0001;}).map(p=>({id:p.id,ref:p.ref,from:old.get(p.id)?[old.get(p.id).x,old.get(p.id).y,old.get(p.id).angle]:null,to:[p.x,p.y,p.angle]})),
    added:b.filter(i=>!ak.has(key(i))),resolved:a.filter(i=>!bk.has(key(i))),remaining:b.length
  };
}

// List connected neighbors by the shortest pad-to-pad distance on each shared net.
export function connectedNeighbors(s,ids){
  const selected=new Set(ids),byNet=new Map();
  for(const p of s.parts)for(const pad of p.pads)if(pad.net&&pad.net!=='0'){
    const items=byNet.get(pad.net)||[];items.push({p,xy:worldPoint(p,pad.x,pad.y)});byNet.set(pad.net,items);
  }
  const neighbors=new Map();
  for(const [net,pads] of byNet){const sources=pads.filter(q=>selected.has(q.p.id));if(!sources.length)continue;
    for(const q of pads)if(!selected.has(q.p.id)){
      const distance=Math.min(...sources.map(a=>Math.hypot(a.xy[0]-q.xy[0],a.xy[1]-q.xy[1]))),k=q.p.id+':'+net;
      if(!neighbors.has(k)||neighbors.get(k).distance>distance)neighbors.set(k,{id:q.p.id,ref:q.p.ref,net,distance});
    }
  }
  return [...neighbors.values()].sort((a,b)=>a.distance-b.distance||a.ref.localeCompare(b.ref));
}

// Straight-line gap between same-side placement envelopes; zero denotes contact/overlap.
export function nearestClearance(s,ids){
  const selected=new Set(ids);let best=null;
  for(const p of s.parts.filter(p=>selected.has(p.id)))for(const q of s.parts){
    if(selected.has(q.id)||p.side!==q.side)continue;
    if(collide(p,q,0))return {a:p.id,b:q.id,ref:q.ref,distance:0,overlap:true};
    const a=polygons(p),b=polygons(q),ap=bounds(a),bp=bounds(b);
    const lower=Math.hypot(Math.max(0,ap.minX-bp.maxX,bp.minX-ap.maxX),Math.max(0,ap.minY-bp.maxY,bp.minY-ap.maxY));
    if(best&&lower>best.distance)continue;
    for(const poly of a)for(const other of b)for(const [u,v] of edges(poly))for(const [w,z] of edges(other)){
      for(const [pt,start,end,reverse] of [[u,w,z,false],[v,w,z,false],[w,u,v,true],[z,u,v,true]]){
        const dx=end[0]-start[0],dy=end[1]-start[1],t=Math.max(0,Math.min(1,((pt[0]-start[0])*dx+(pt[1]-start[1])*dy)/(dx*dx+dy*dy||1)));
        const projection=[start[0]+t*dx,start[1]+t*dy],distance=Math.hypot(pt[0]-projection[0],pt[1]-projection[1]);
        if(!best||distance<best.distance)best={a:p.id,b:q.id,ref:q.ref,distance,from:reverse?projection:pt,to:reverse?pt:projection,overlap:false};
      }
    }
  }
  return best;
}
