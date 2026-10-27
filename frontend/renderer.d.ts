export interface PaintedPlayer {name:string;x:number;y:number;ours:boolean;color:string;skin:string;hair:string}
export interface PaintedAgent {x:number;y:number;state?:string;}
export function createPainter(canvas:HTMLCanvasElement):(players:PaintedPlayer[],time:number,agent?:PaintedAgent)=>void;
