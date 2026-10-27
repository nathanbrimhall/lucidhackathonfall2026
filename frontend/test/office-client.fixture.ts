// UI-only fixture: no HTTP, WebSocket, microphone or provider connections.
import type {AIStatus} from '../../shared/src/protocol.js';
export class OfficeClient{
 identity={userId:'nathan',displayName:'Nathan'};token='fictional';
 self={status:'available',audioMode:'meeting',zoneId:'meeting-east'};
 room={state:{meetings:new Map([['meeting-east',{occupancy:2,meetingSessionId:'meeting-1'}]])}};
 players=[{userId:'nathan',displayName:'Nathan',x:36,y:14,status:'available',audioMode:'meeting'}];
 meetingId='meeting-1';ai?:AIStatus;media=undefined;mic=false;deafened=false;
 status='Connected as Nathan';mediaStatus='Synthetic media status';path:unknown[]=[];keys=new Set<string>();
 messages:{type:string;value:any}[]=[];apiCalls:{path:string;body?:any}[]=[];
 constructor(private changed:()=>void,private event:(type:string,value:any)=>void){
  (window as any).__officeUiTest={client:this,updateMedia:()=>{this.mediaStatus+=' update';this.changed();}};
  setTimeout(()=>this.event('connected',this.identity),0);
 }
 async api<T=any>(path:string,body?:any):Promise<T>{
  this.apiCalls.push({path,body});let value:any;
  if(path==='/api/demo')value={enabled:false,users:[]};
  else if(path==='/api/collaboration')value={identity:this.identity,directory:[this.identity],profile:{skills:'',allowInterrupt:false},tasks:[],notifications:[],messages:[],drafts:[],assistantUsage:{configured:false},assistantConfigured:true};
  else if(path==='/api/notes')value={notes:[]};
  else if(path==='/api/reminders')value={reminders:[]};
  else if(path==='/api/assistant')value={status:'supported',items:[{kind:'draft_decision',text:'A saved draft records audio-only scope.',sourceIds:['note-1']}],sources:[{id:'note-1',type:'saved_note',text:'Use audio only.'}]};
  else throw new Error('Unexpected UI-only API path');
  return value as T;
 }
 send(type:string,value:any){
  this.messages.push({type,value});
  if(type==='ai.request'){
   this.ai={aiSessionId:'ai-1',meetingSessionId:this.meetingId,revision:1,status:'requesting_consent',roster:[{userId:'nathan',displayName:'Nathan',consented:false},{userId:'cameron',displayName:'Cameron',consented:false}]};
   this.changed();
  }
 }
 async join(){}async useDemo(){}async resume(){}async retryAudio(){}async toggleMic(){}
 leave(){}goTo(){}toggleSound(){}
}
