import { randomUUID } from 'node:crypto';
import type { AuthService } from '../auth/AuthService.js';
import type { AIRepository } from '../repositories/AIRepository.js';
import type { CollaborationService } from '../services/CollaborationService.js';
import type { Config } from '../config.js';
import type { GuestSession } from '../../../shared/src/protocol.js';
/** Only the explicit loopback, in-memory manual-demo launcher calls this. Never real speech. */
export function seedManualDemo(auth:AuthService,notes:AIRepository,collaboration:CollaborationService,config:Config){
 const users=['Demo Nathan','Demo Cameron','Demo Maya'].map(displayName=>auth.createGuest({displayName,inviteCode:config.inviteCode}) as GuestSession);
 const [nathan,cameron,maya]=users;collaboration.updateProfile(cameron,{skills:'LiveKit transcript exports, stable speaker IDs and timestamps'});collaboration.updateProfile(nathan,{skills:'Task review interfaces and message drafts'});collaboration.updateProfile(maya,{skills:'Speaker attribution tests and data validation'});
 const task=(who:GuestSession,title:string,open:boolean)=>{const result=collaboration.createTask(who,{requestId:randomUUID(),title,ownerUserId:who.userId});return open?collaboration.updateTask(who,result.id,{revision:result.revision,status:'open'}):result;};
 task(cameron,'Export stable speaker IDs and timestamps',true);task(nathan,'Build task preview after the speaker-ID export is ready',true);task(nathan,'Export stable speaker IDs and timestamps',false);task(maya,'Run attribution tests after the speaker-ID export is ready',true);
 const now=new Date();const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Denver',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);const part=(key:string)=>Number(parts.find(p=>p.type===key)!.value);const yesterday=new Date(Date.UTC(part('year'),part('month')-1,part('day')-1,18));
 function note(createdAt:string,summary:string[],decisions:string[],actions:{text:string;ownerUserId:string}[]){const id=randomUUID(),meetingSessionId=randomUUID();notes.save({aiSessionId:id,meetingSessionId,revision:1,status:'completed',roster:[nathan,cameron].map(p=>({userId:p.userId,displayName:p.displayName,consented:true})),officeId:config.officeId,requestKey:'synthetic-'+id,createdAt:Date.parse(createdAt),partial:false,readers:[nathan.userId,cameron.userId]});notes.saveNote({id:randomUUID(),aiSessionId:id,createdAt,partial:false,draft:{summary:[{text:'Fictional manual-demo fixture. No audio was captured.',segmentIds:['fixture']},...summary.map(text=>({text,segmentIds:['fixture']}))],decisions:decisions.map(text=>({text,segmentIds:['fixture']})),actionItems:actions.map(a=>({...a,segmentIds:['fixture'],dueAt:null}))}},[nathan.userId,cameron.userId]);}
 note(yesterday.toISOString(),['The team considered Teams delivery only if the organization approves app access. This was conditional.'],['Try Teams delivery only if app registration is approved.'],[]);
 note(now.toISOString(),[
 'The team selected audio-only demo scope to reduce camera and layout work. That was the explicitly stated reason.',
 'App registration is blocked in this fictional scenario. The draft records replacing the conditional Teams plan with local Slack-style message previews; external delivery is not connected.',
 'Nathan assumes video will be included because the audio service supports it. No scope change was approved; this assumption conflicts with the recorded audio-only scope.',
 'The note-retention period is unresolved. Bring it to the next meeting rather than assuming a policy.',
 'Nathan\'s task preview and Maya\'s attribution tests are blocked until Cameron exports stable speaker IDs and timestamps.',
 'Nathan\'s proposed export duplicates the existing export accepted by Cameron. Confirm with Cameron before creating or transferring that work.'
 ],['Use audio only for this demo; defer video.','Replace the conditional Teams plan with local Slack-style message previews, with human review before delivery.'],[{text:'Export stable speaker IDs and timestamps',ownerUserId:cameron.userId},{text:'Build task preview after the speaker-ID export is ready',ownerUserId:nathan.userId}]);
 return users;
}
