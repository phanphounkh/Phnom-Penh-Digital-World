import type { ChunkPayload } from '$lib/api/types';
import { FileAudio } from './FileAudio';
import { BackgroundMusic } from './BackgroundMusic';

export interface AudioSettings { master: number; ambience: number; effects: number; music: number; muted: boolean }
export const AUDIO_DEFAULTS: AudioSettings = { master: .6, ambience: .35, effects: .8, music: .25, muted: false };
const KEY = 'ppw-audio-v1';
export function audioSettings(input: Partial<AudioSettings>): AudioSettings {
	const level = (key: 'master' | 'ambience' | 'effects' | 'music') =>
		typeof input[key] === 'number' && Number.isFinite(input[key]) ? Math.min(1,Math.max(0,input[key]!)) : AUDIO_DEFAULTS[key];
	return { master: level('master'), ambience: level('ambience'), effects: level('effects'), music: level('music'), muted: typeof input.muted === 'boolean' ? input.muted : false };
}

/** Distance to mapped water, sampled outside the audio graph at low frequency. */
export function waterProximity(payloads: ChunkPayload[], x: number, z: number): number {
	let closest = 70;
	for (const payload of payloads) for (const area of payload.areas) {
		if (area.kind !== 'water') continue;
		for (const polygon of area.polys) for (const ring of polygon) for (let i=0;i<ring.length;i++) {
			const a=ring[i], b=ring[(i+1)%ring.length], dx=b[0]-a[0], dz=b[1]-a[1];
			const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz || 1)));
			closest=Math.min(closest,Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz));
		}
	}
	return 1-closest/70;
}

export interface AudioFrame { x: number; z: number; lift: number; speed: number; indoor: number; night: number; riding: string | null; paused: boolean; water: number; road: boolean; propelling: boolean }

/** File-based action effects; optional Web Audio ambience uses a separate graph. */
export class WorldAudio {
    private files = new FileAudio();
    private music = new BackgroundMusic();
    get started(): boolean { return this.files.enabled; }
    get playbackState(): string { return this.files.error ? 'blocked' : this.files.enabled ? 'running' : 'not_started'; }
    get lastError(): string { return this.files.error || this.music.error || (!this.files.enabled ? this.webError : ''); }
    settings = { ...AUDIO_DEFAULTS };
    private webError='';
    private context: AudioContext | null=null;
    private master: GainNode | null=null;
    private ambient: GainNode | null=null;
    private analyser: AnalyserNode | null=null;
    private wind: GainNode | null=null;
    private river: GainNode | null=null;
    private traffic: GainNode | null=null;
    private sources: AudioBufferSourceNode[]=[];
    private disposed=false;
    private birdClock=16;
    private gesture=()=>{void this.unlock();};
    private visibility=()=>{
        this.files.visibility();this.music.visibility();
        if(!this.context || this.disposed)return;
        if(document.hidden)void this.context.suspend().catch(()=>{});
        else if(!this.settings.muted)void this.context.resume().catch(()=>{});
    };
    constructor(){
        try{this.settings=audioSettings(JSON.parse(localStorage.getItem(KEY)||'{}'));}catch{/* optional storage */}
        this.files.configure(this.settings);this.music.configure(this.settings);
        for(const type of ['pointerdown','keydown','click'])window.addEventListener(type,this.gesture,true);
        document.addEventListener('visibilitychange',this.visibility);
    }
    async unlock(): Promise<void>{
        if(this.disposed || document.hidden || this.settings.muted)return;
        // Start native media during the gesture, before awaiting any Web Audio work.
        this.files.unlock();this.music.unlock();
        try{
            if(!window.AudioContext)return;
            if(this.context?.state==='closed')this.context=null;
            if(!this.context){
                const c=this.context=new AudioContext();
                this.master=c.createGain();this.ambient=c.createGain();this.analyser=c.createAnalyser();this.analyser.fftSize=256;
                this.ambient.connect(this.master);this.master.connect(this.analyser);this.analyser.connect(c.destination);
                const noise=c.createBuffer(1,c.sampleRate*2,c.sampleRate), data=noise.getChannelData(0);
                for(let i=0;i<data.length;i++)data[i]=Math.random()*2-1;
                const bed=(type:BiquadFilterType,hz:number)=>{
                    const source=c.createBufferSource(),filter=c.createBiquadFilter(),gain=c.createGain();
                    source.buffer=noise;source.loop=true;filter.type=type;filter.frequency.value=hz;filter.Q.value=.6;gain.gain.value=0;
                    source.connect(filter);filter.connect(gain);gain.connect(this.ambient!);source.start();this.sources.push(source);return gain;
                };
                this.wind=bed('lowpass',450);this.river=bed('bandpass',1000);this.traffic=bed('lowpass',120);
                this.configure(this.settings);
            }
            if(this.context.state!=='running')await this.context.resume();
            this.webError='';
        }catch(error){this.webError=error instanceof Error ? error.message : 'Ambient audio unavailable';}
    }
    configure(input:Partial<AudioSettings>){
        this.settings=audioSettings({...this.settings,...input});this.files.configure(this.settings);this.music.configure(this.settings);
        try{localStorage.setItem(KEY,JSON.stringify(this.settings));}catch{/* optional storage */}
        const t=this.context?.currentTime ?? 0;
        this.master?.gain.setTargetAtTime(this.settings.muted ? 0 : this.settings.master,t,.04);
        this.ambient?.gain.setTargetAtTime(this.settings.ambience,t,.04);
    }
    async testSound(): Promise<void>{
        this.configure({muted:false,master:this.settings.master>0 ? this.settings.master : AUDIO_DEFAULTS.master,
            effects:this.settings.effects>0 ? this.settings.effects : AUDIO_DEFAULTS.effects});
        // Native play() is called synchronously inside the user's click handler.
        const playing=this.files.testSound();void this.unlock();await playing;
    }
    update(dt:number,f:AudioFrame){
        this.files.update(dt,f);
        const c=this.context;if(!c || c.state!=='running' || this.settings.muted || this.disposed)return;
        const outside=1-Math.min(1,f.indoor)*.9,t=c.currentTime;
        this.wind?.gain.setTargetAtTime(.06*outside,t,.5);
        this.river?.gain.setTargetAtTime(.18*f.water*outside,t,.5);
        this.traffic?.gain.setTargetAtTime((f.road ? .13 : .025)*outside,t,.5);
        this.birdClock-=dt;
        if(this.birdClock<0){
            if(f.night<.4 && f.indoor<.2){
                const osc=c.createOscillator(),gain=c.createGain();osc.frequency.setValueAtTime(1600,t);
                osc.frequency.exponentialRampToValueAtTime(2800,t+.08);osc.frequency.exponentialRampToValueAtTime(1800,t+.2);
                gain.gain.setValueAtTime(.001,t);gain.gain.linearRampToValueAtTime(.025,t+.025);gain.gain.exponentialRampToValueAtTime(.0001,t+.25);
                osc.connect(gain);gain.connect(this.ambient!);osc.onended=()=>{osc.disconnect();gain.disconnect();};osc.start();osc.stop(t+.26);
            }this.birdClock=15+Math.random()*18;
        }
    }
    diagnostics(){
        let rms=0;if(this.analyser){const data=new Float32Array(256);this.analyser.getFloatTimeDomainData(data);rms=Math.sqrt(data.reduce((s,v)=>s+v*v,0)/data.length);}
        const media=this.files.diagnostics();
        return {state:this.playbackState,error:this.lastError,footsteps:media.footsteps,gaitSteps:media.gaitSteps,landings:media.landings,
            bikeTicks:media.bikeTicks,vehicle:media.vehicle,media,music:this.music.diagnostics(),rms,settings:{...this.settings}};
    }
    dispose(){
        this.disposed=true;this.files.dispose();this.music.dispose();
        for(const type of ['pointerdown','keydown','click'])window.removeEventListener(type,this.gesture,true);
        document.removeEventListener('visibilitychange',this.visibility);
        for(const source of this.sources){try{source.stop();source.disconnect();}catch{/* already stopped */}}
        void this.context?.close().catch(()=>{});this.context=null;
    }
}
