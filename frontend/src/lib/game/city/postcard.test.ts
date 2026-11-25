import { expect,it,vi,afterEach } from 'vitest';
import * as THREE from 'three';
import { capturePostcard } from './postcard';
afterEach(()=>vi.unstubAllGlobals());
it('caps exports, hides the route only in the image and restores the live scene',async()=>{
 const route=new THREE.Group(),seen:boolean[]=[];
 const renderer={domElement:{width:3200,height:1800},render:()=>seen.push(route.visible)} as unknown as THREE.WebGLRenderer;
 const image={width:0,height:0,getContext:()=>({drawImage:vi.fn()}),toBlob:(done:(b:Blob)=>void)=>done(new Blob(['png']))};
 vi.stubGlobal('document',{createElement:()=>image});
 const blob=await capturePostcard(renderer,new THREE.Scene(),new THREE.PerspectiveCamera(),[route]);
 expect(image.width).toBe(1600);expect(image.height).toBe(900);expect(blob.size).toBeGreaterThan(0);expect(seen).toEqual([false,true]);expect(route.visible).toBe(true);
});
it('restores navigation when the browser cannot create an image',async()=>{
 const route=new THREE.Group();const renderer={domElement:{width:100,height:100},render:vi.fn()} as unknown as THREE.WebGLRenderer;
 vi.stubGlobal('document',{createElement:()=>({getContext:()=>null})});
 await expect(capturePostcard(renderer,new THREE.Scene(),new THREE.Camera(),[route])).rejects.toThrow('camera');expect(route.visible).toBe(true);
});
