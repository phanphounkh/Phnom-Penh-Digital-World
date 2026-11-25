import type * as THREE from 'three';
/** Copy the actual game frame on request. Hide navigation just for the photo, then
 * restore it even if capture fails. No preserveDrawingBuffer, GPU target or upload. */
export async function capturePostcard(renderer: THREE.WebGLRenderer,scene: THREE.Scene,camera: THREE.Camera,hidden: THREE.Object3D[]=[]): Promise<Blob> {
 const visibility=hidden.map(object=>object.visible);
 let canvas: HTMLCanvasElement;
 try {
  hidden.forEach(object=>object.visible=false);renderer.render(scene,camera);
  const source=renderer.domElement,scale=Math.min(1,1600/source.width);
  canvas=document.createElement('canvas');canvas.width=Math.round(source.width*scale);canvas.height=Math.round(source.height*scale);
  const context=canvas.getContext('2d');if(!context||!canvas.width||!canvas.height)throw new Error('The camera is not ready yet.');
  context.drawImage(source,0,0,canvas.width,canvas.height);
 } finally {
  hidden.forEach((object,i)=>object.visible=visibility[i]);renderer.render(scene,camera);
 }
 return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not capture this view.')),'image/png'));
}
