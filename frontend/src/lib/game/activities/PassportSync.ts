import { api } from '$lib/api/client';
import { STOPS, type Passport } from './passport';
export interface Achievements { version: 1; stamps: string[]; delivered: boolean }
export type SyncStatus = 'syncing' | 'saved' | 'offline';
export function mergeAchievements(local: Passport, remote: Achievements): Passport {
 return {...local, stamps: STOPS.filter(slug=>local.stamps.includes(slug)||remote.stamps.includes(slug)), delivered: local.delivered||remote.delivered};
}
/** Completed keepsakes merge monotonically; active practice runs stay on their browser.
 * One in-flight sync, coalesced updates, and bounded retry through the page's timer. */
export class PassportSync {
 private busy=false;
 private again=false;
 private disposed=false;
 private abort=new AbortController();
 constructor(private current: ()=>Passport, private apply: (state: Passport)=>void, private status: (status: SyncStatus)=>void,
  private request: typeof api=api) {}
 async sync(): Promise<void> {
  if(this.disposed)return;
  if(this.busy){this.again=true;return;}
  this.busy=true;this.status('syncing');
  try {
   do {
    this.again=false;
    const remote=await this.request<Achievements>('/me/passport',{signal:this.abort.signal});
    if(this.disposed)return;
    const merged=mergeAchievements(this.current(),remote);
    this.apply(merged);
    if(merged.stamps.some(s=>!remote.stamps.includes(s)) || merged.delivered!==remote.delivered){
     const saved=await this.request<Achievements>('/me/passport',{method:'POST',body:{version:1,stamps:merged.stamps,delivered:merged.delivered},signal:this.abort.signal});
     if(this.disposed)return;
     this.apply(mergeAchievements(this.current(),saved));
    }
   } while(this.again && !this.disposed);
   this.status('saved');
  } catch {if(!this.disposed)this.status('offline');}
  finally {this.busy=false;}
 }
 dispose(): void {this.disposed=true;this.abort.abort();}
}
