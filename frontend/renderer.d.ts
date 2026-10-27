export interface PaintedPlayer {name:string;x:number;y:number;ours:boolean;color:string;skin:string;hair:string}
export function createPainter(canvas:HTMLCanvasElement):(players:PaintedPlayer[],time:number)=>void;
