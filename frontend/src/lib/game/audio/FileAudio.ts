import type { AudioFrame, AudioSettings } from './WorldAudio';
import { footProfile, vehicleProfile } from './movement';

/** Standard HTML media playback, independent of Web Audio contexts and routing. */
export class FileAudio {
	enabled=false;
	error='';
	private settings: AudioSettings = {master:.6,effects:.8,ambience:.35,music:.25,muted:false};
	private loops = new Map<string,HTMLAudioElement>();
	private steps: HTMLAudioElement[]=[];
	private test: HTMLAudioElement | null=null;
	private cursor=0;
	private previous: {x:number;z:number} | null=null;
	private distance=0;
	private airborne=false;
	private footsteps=0;
	private landings=0;
	private gaitSteps={walk:0,run:0,sprint:0};
	private bikeTicks=0;
	private bikeClock=0;
	private vehicle=vehicleProfile(null,0,0,false,false);
	private disposed=false;
	private create(name:string,loop=false): HTMLAudioElement {
		const el=new Audio(`/audio/${name}.wav`);
		el.preload='auto';el.loop=loop;el.volume=0;el.preservesPitch=false;
		el.onerror=()=>{this.error=`Could not load /audio/${name}.wav. Reload the game.`;};
		return el;
	}
	private initialise() {
		if(this.test || this.disposed) return;
		this.test=this.create('test-tone');
		for(const name of ['motorbike','bicycle-pedal','bicycle-coast']) this.loops.set(name,this.create(name,true));
		for(let i=0;i<4;i++) this.steps.push(this.create('walk'));
	}
	unlock() {
		if(this.disposed || this.settings.muted || document.hidden) return;
		this.initialise();this.enabled=true;this.error='';
		for(const el of this.loops.values()) if(el.paused) void el.play().catch(error=>{this.error=`Sound is blocked: ${error.message}`;});
	}
	configure(settings:AudioSettings) {
		this.settings={...settings};
		if(settings.muted || settings.master===0 || settings.effects===0) {
			for(const el of [...this.loops.values(),...this.steps]) el.volume=0;
		}
		if(this.test) this.test.volume=settings.muted ? 0 : settings.master;
	}
	async testSound() {
		this.initialise();this.unlock();
		if(!this.test) return;
		this.test.pause();this.test.currentTime=0;this.test.volume=this.settings.master;
		try {await this.test.play();this.enabled=true;this.error='';}
		catch(error) {this.error=`Browser blocked the test sound: ${error instanceof Error ? error.message : 'playback failed'}`;}
	}
	private foot(speed:number,landing=false) {
		const profile=footProfile(speed), el=this.steps[this.cursor++%this.steps.length];
		const path=`/audio/${landing ? 'landing' : profile.gait==='walk' ? 'walk' : 'run'}.wav`;
		if(!el.src.endsWith(path)) el.src=path;
		el.pause();el.currentTime=0;
		el.volume=Math.min(1,this.settings.master*this.settings.effects*(landing ? .9 : profile.gait==='walk' ? .65 : .85));
		el.playbackRate=profile.gait==='sprint' ? 1.15 : 1;
		void el.play().catch(error=>{this.error=`Footstep playback failed: ${error.message}`;});
		if(landing)this.landings++;else{this.footsteps++;this.gaitSteps[profile.gait]++;}
	}
	update(dt:number,f:AudioFrame) {
		const moved=this.previous ? Math.hypot(f.x-this.previous.x,f.z-this.previous.z) : 0;
		this.previous={x:f.x,z:f.z};
		if(!this.enabled || this.disposed || this.settings.muted || document.hidden) {this.distance=0;this.airborne=f.lift>.04;return;}
		const gain=this.settings.master*this.settings.effects;
		const rolling=moved<3 ? moved/Math.max(.001,dt) : 0;
		this.vehicle=vehicleProfile(f.riding,f.speed,rolling,f.propelling,f.paused);
		for(const [kind,el] of this.loops) {
			let target=0,rate=1;
			if(!f.paused && kind==='motorbike' && f.riding==='motorbike') {target=.36+Math.min(.3,f.speed*.025)+(f.propelling ? .08 : 0);rate=.8+Math.min(1,f.speed*.07)+(f.propelling ? .12 : 0);}
			if(!f.paused && f.riding==='bicycle' && rolling>.2 && kind===(f.propelling ? 'bicycle-pedal' : 'bicycle-coast')) {
				target=f.propelling ? .45 : .6;rate=.65+Math.min(1.2,rolling*.1);
				this.bikeClock+=dt*(f.propelling ? 4 : 9)*el.playbackRate;
				const ticks=Math.floor(this.bikeClock);this.bikeTicks+=ticks;this.bikeClock-=ticks;
			}
			el.volume=Math.max(0,Math.min(1,el.volume+(target*gain-el.volume)*(1-Math.exp(-dt*14))));
			el.playbackRate+=(rate-el.playbackRate)*(1-Math.exp(-dt*8));
		}
		const air=f.lift>.04;
		if(this.airborne && !air && !f.riding && !f.paused)this.foot(f.speed,true);
		this.airborne=air;
		if(!air && !f.riding && !f.paused && moved<3) {
			this.distance+=moved;if(this.distance>footProfile(f.speed).stride){this.foot(f.speed);this.distance=0;}
		}else this.distance=0;
	}
	visibility() {
		if(document.hidden)for(const el of [...this.loops.values(),...this.steps,...(this.test?[this.test]:[])])el.pause();
		else this.unlock();
	}
	diagnostics() {
		return {enabled:this.enabled,error:this.error,footsteps:this.footsteps,gaitSteps:{...this.gaitSteps},landings:this.landings,bikeTicks:this.bikeTicks,vehicle:{...this.vehicle},
			testPlaying:!!this.test && !this.test.paused,testTime:this.test?.currentTime ?? 0,
			steps:this.steps.map(el=>({playing:!el.paused,time:el.currentTime,volume:el.volume,ready:el.readyState})),
			loops:[...this.loops].map(([kind,el])=>({kind,playing:!el.paused,time:el.currentTime,volume:el.volume,rate:el.playbackRate}))};
	}
	dispose() {
		this.disposed=true;for(const el of [...this.loops.values(),...this.steps,...(this.test?[this.test]:[])]){el.pause();el.removeAttribute('src');el.load();}
		this.loops.clear();this.steps=[];this.test=null;
	}
}
