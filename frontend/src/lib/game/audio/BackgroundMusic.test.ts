import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackgroundMusic, MUSIC_TRACK } from './BackgroundMusic';
class Media {
 static instances: Media[] = [];
 paused = true; volume = 1; loop = false; preload = ''; currentTime = 7;
 duration = 51.2; readyState = 4; onerror: (()=>void)|null = null;
 play = vi.fn(async()=>{this.paused=false;});
 pause = vi.fn(()=>{this.paused=true;});
 removeAttribute = vi.fn(); load = vi.fn();
 constructor(public src: string){Media.instances.push(this);}
}
let hidden=false;
beforeEach(()=>{hidden=false;Media.instances=[];vi.stubGlobal('Audio',Media);vi.stubGlobal('document',{get hidden(){return hidden;}});});
afterEach(()=>vi.unstubAllGlobals());
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
it('loads only after interaction and loops one local track independently of effects',async()=>{
 const music=new BackgroundMusic();music.configure({master:.6,music:.25,muted:false});
 expect(Media.instances).toHaveLength(0);music.unlock();await flush();
 const media=Media.instances[0];expect(media.src).toBe(MUSIC_TRACK.url);expect(media.loop).toBe(true);
 expect(media.volume).toBeCloseTo(.15);expect(music.diagnostics().playing).toBe(true);
 music.unlock();expect(Media.instances).toHaveLength(1);expect(media.play).toHaveBeenCalledTimes(1);
});
it('pauses at zero music volume or mute, preserving position and resuming on restore',async()=>{
 const music=new BackgroundMusic();music.unlock();await flush();const media=Media.instances[0];
 music.configure({master:.6,music:0,muted:false});expect(media.paused).toBe(true);expect(media.currentTime).toBe(7);
 music.configure({master:.6,music:.4,muted:false});await flush();expect(media.paused).toBe(false);expect(media.volume).toBeCloseTo(.24);
 music.configure({master:.6,music:.4,muted:true});expect(media.paused).toBe(true);expect(media.volume).toBe(0);
});
it('pauses hidden tabs and releases media on teardown',async()=>{
 const music=new BackgroundMusic();music.unlock();await flush();const media=Media.instances[0];
 hidden=true;music.visibility();expect(media.paused).toBe(true);
 hidden=false;music.visibility();await flush();expect(media.paused).toBe(false);
 music.dispose();expect(media.paused).toBe(true);expect(media.removeAttribute).toHaveBeenCalledWith('src');
 expect(media.load).toHaveBeenCalled();music.unlock();expect(Media.instances).toHaveLength(1);
});
it('allows retry after browser playback rejection',async()=>{
 const music=new BackgroundMusic();music.configure({master:0,music:.25,muted:false});music.unlock();
 const media=Media.instances[0];media.play.mockRejectedValueOnce(new Error('NotAllowedError'));
 music.configure({master:.6,music:.25,muted:false});await flush();expect(music.error).toContain('Click the game');
 music.unlock();await flush();expect(music.error).toBe('');expect(media.paused).toBe(false);
});
