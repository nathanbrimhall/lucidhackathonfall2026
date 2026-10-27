import type { OfficeMap, Point } from "./map-contract.js";
import { isPositionWalkable } from "./collision.js";
/** Client plans intentions only; the server remains the position authority. */
export function planPath(map:OfficeMap,from:Point,to:Point):Point[]{
 const step=.5,key=(x:number,y:number)=>`${x},${y}`;const sx=Math.round(from.x/step),sy=Math.round(from.y/step),tx=Math.round(to.x/step),ty=Math.round(to.y/step);
 if(!isPositionWalkable(map,{x:tx*step,y:ty*step}))return [];
 const queue=[{x:sx,y:sy}],parents=new Map<string,string|null>([[key(sx,sy),null]]);let cursor=0;
 while(cursor<queue.length&&cursor<20000){const p=queue[cursor++],id=key(p.x,p.y);if(p.x===tx&&p.y===ty){const result:Point[]=[];let at:string|null=id;while(at&&parents.get(at)!==null){const [x,y]=at.split(',').map(Number);result.unshift({x:x*step,y:y*step});at=parents.get(at)??null;}return result;}
 for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const x=p.x+dx,y=p.y+dy,k=key(x,y);if(parents.has(k)||!isPositionWalkable(map,{x:x*step,y:y*step}))continue;parents.set(k,id);queue.push({x,y});}}
 return [];
}
