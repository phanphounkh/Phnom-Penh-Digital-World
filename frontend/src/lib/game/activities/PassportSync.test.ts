import { expect, it, vi } from 'vitest';
import type { api } from '$lib/api/client';
import { emptyPassport, type Passport } from './passport';
import { PassportSync, mergeAchievements, type Achievements } from './PassportSync';
const blank: Achievements={version:1,stamps:[],delivered:false};
it('hydrates a new browser without uploading empty progress or discarding its active delivery',async()=>{
 const delivery={stage:'carrying' as const,pickup:{x:0,z:0,label:'Café'},dropoff:{x:20,z:30,label:'Garden'}};
 let state: Passport={...emptyPassport(),delivery};const status=vi.fn();
 const request=vi.fn().mockResolvedValue({...blank,stamps:['wat-phnom'],delivered:true});
 await new PassportSync(()=>state,s=>state=s,status,request as typeof api).sync();
 expect(state).toEqual({...emptyPassport(),stamps:['wat-phnom'],delivered:true,delivery});
 expect(request).toHaveBeenCalledTimes(1);expect(status).toHaveBeenLastCalledWith('saved');
});
it('imports legacy achievements without sending active runs or coordinates to the server',async()=>{
 let state: Passport={...emptyPassport(),stamps:['wat-phnom'],delivered:true};
 const request=vi.fn().mockResolvedValueOnce(blank).mockResolvedValueOnce({...blank,stamps:['wat-phnom'],delivered:true});
 await new PassportSync(()=>state,s=>state=s,vi.fn(),request as typeof api).sync();
 expect(request.mock.calls[1][1].body).toEqual({version:1,stamps:['wat-phnom'],delivered:true});
});
it('coalesces simultaneous changes and never loses rewards earned during a pending response',async()=>{
 let state: Passport=emptyPassport();let finish!: (value: Achievements)=>void;
 const request=vi.fn().mockImplementationOnce(()=>new Promise<Achievements>(r=>finish=r)).mockResolvedValue({...blank,stamps:['central-market']});
 const sync=new PassportSync(()=>state,s=>state=s,vi.fn(),request as typeof api);
 const first=sync.sync();state={...state,stamps:['wat-phnom']};void sync.sync();
 finish({...blank,stamps:['central-market']});await first;
 expect(state.stamps).toEqual(['wat-phnom','central-market']);
 expect(request.mock.calls.filter(c=>c[1].method==='POST').length).toBeGreaterThan(0);
});
it('keeps local progress during network failure, supports retry, and stops applying after disposal',async()=>{
 let state: Passport={...emptyPassport(),stamps:['wat-phnom']};const status=vi.fn();
 const request=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({...blank,stamps:['wat-phnom']});
 const sync=new PassportSync(()=>state,s=>state=s,status,request as typeof api);
 await sync.sync();expect(state.stamps).toEqual(['wat-phnom']);expect(status).toHaveBeenLastCalledWith('offline');
 await sync.sync();expect(status).toHaveBeenLastCalledWith('saved');
 sync.dispose();await sync.sync();expect(request).toHaveBeenCalledTimes(2);
 expect(mergeAchievements(state,blank).stamps).toEqual(['wat-phnom']);
});
it('aborts on teardown without applying a late response to another page',async()=>{
 let finish!: (value: Achievements)=>void;const apply=vi.fn();
 const request=vi.fn().mockImplementation(()=>new Promise<Achievements>(r=>finish=r));
 const sync=new PassportSync(emptyPassport,apply,vi.fn(),request as typeof api);
 const pending=sync.sync();sync.dispose();finish({...blank,stamps:['wat-phnom']});await pending;
 expect(apply).not.toHaveBeenCalled();expect(request.mock.calls[0][1].signal.aborted).toBe(true);
});
