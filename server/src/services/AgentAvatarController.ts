import type { OfficeMap, Point } from '../../../shared/src/map-contract.js';
import { isPositionWalkable } from '../../../shared/src/collision.js';
import { planPath } from '../../../shared/src/navigation.js';

export interface PublicAgentStatus { state: string; sponsorUserId?: string | null }
export interface AgentAvatar extends Point { agentId: string; state: string; sponsorUserId: string; badge: string }

/** One server-owned, nonblocking avatar. Movement never controls request delivery. */
export class AgentAvatarController {
  readonly avatar: AgentAvatar;
  private readonly home: Point;
  private path: Point[] = [];
  private destination = '';
  private desiredState = 'idle';
  constructor(private readonly map: OfficeMap) {
    this.home = { ...map.spawnPoints[0] };
    this.avatar = { ...this.home, agentId: 'office-agent', state: 'idle', sponsorUserId: '', badge: 'AI' };
  }
  update(status: PublicAgentStatus, target?: Point): void {
    this.desiredState = status.state;
    this.avatar.sponsorUserId = status.sponsorUserId ?? '';
    // Search nearby reachable points instead of occupying a person's exact tile.
    const options = target
      ? [{x:target.x-1,y:target.y},{x:target.x+1,y:target.y},{x:target.x,y:target.y-1},{x:target.x,y:target.y+1}]
      : [this.home];
    const key = target ? `${Math.round(target.x)},${Math.round(target.y)}` : 'home';
    if (key !== this.destination) {
      this.destination = key;
      this.path = [];
      for (const option of options) {
        if (!isPositionWalkable(this.map, option)) continue;
        const path = planPath(this.map, this.avatar, option);
        if (path.length) { this.path = [...path,{...option}]; break; }
      }
    }
    this.avatar.state = this.path.length ? 'walking' : this.desiredState;
  }
  tick(elapsedMs: number): void {
    let distance = Math.min(100, Math.max(0, elapsedMs)) / 1000 * 2.5;
    while (distance > 0 && this.path.length) {
      const next = this.path[0], dx = next.x-this.avatar.x, dy = next.y-this.avatar.y, length = Math.hypot(dx,dy);
      const amount = Math.min(distance,length);
      const point = length ? {x:this.avatar.x+dx/length*amount,y:this.avatar.y+dy/length*amount} : next;
      if (!isPositionWalkable(this.map,point)) { this.path=[]; break; }
      this.avatar.x=point.x; this.avatar.y=point.y; distance-=amount;
      if (length<=amount) this.path.shift();
    }
    this.avatar.state = this.path.length ? 'walking' : this.desiredState;
  }
}
