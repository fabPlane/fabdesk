import {rect,collide} from './geometry';

const cache=new WeakMap();
export function areaObstacle(area,side='F'){
  const signature=[area.x,area.y,area.w,area.h,side].join('|');let value=cache.get(area);
  if(!value||value.signature!==signature){
    const part={id:'area:'+area.id,x:area.x,y:area.y,angle:0,side,contours:[rect([0,0],[area.w,area.h])]};
    value={signature,part};cache.set(area,value);
  }
  return value.part;
}
export function reservedConflicts(s,p){
  return (s.reservedAreas||[]).filter(a=>(a.side==='both'||a.side===p.side)&&collide(p,areaObstacle(a,p.side),a.margin));
}
export function validatePlacementSettings(s){
  if(s.reservedAreas!==undefined){
    if(!Array.isArray(s.reservedAreas)||s.reservedAreas.length>1000)throw Error('Invalid reserved areas.');
    const ids=new Set();
    for(const a of s.reservedAreas){
      if(!a||typeof a.id!=='string'||!a.id||ids.has(a.id)||typeof a.name!=='string'||a.name.length>120||!['F','B','both'].includes(a.side)||![a.x,a.y,a.w,a.h,a.margin].every(Number.isFinite)||Math.abs(a.x)>10000||Math.abs(a.y)>10000||a.w<=0||a.h<=0||a.w>2000||a.h>2000||a.margin<0||a.margin>100)throw Error('Invalid reserved area.');
      ids.add(a.id);
    }
  }
  if(s.spacingGuidelines!==undefined){
    const g=s.spacingGuidelines;
    if(!g||typeof g!=='object'||typeof g.enabled!=='boolean'||![g.courtyard,g.edge].every(n=>Number.isFinite(n)&&n>=0&&n<=10))throw Error('Invalid spacing guidelines.');
  }
  if(s.netWeights!==undefined){
    if(!s.netWeights||typeof s.netWeights!=='object'||Array.isArray(s.netWeights)||Object.entries(s.netWeights).some(([name,weight])=>!name||!Number.isFinite(weight)||weight<0||weight>100))throw Error('Invalid net weights.');
  }
}
export const netWeight=(s,name)=>Object.hasOwn(s.netWeights||{},name)?s.netWeights[name]:1;
