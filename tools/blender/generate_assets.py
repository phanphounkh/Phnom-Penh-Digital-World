"""Original CampusEats assets. Run: blender -b --python tools/blender/generate_assets.py
Also supports the official bpy Python wheel. All generated assets are original CC0.
"""
import bpy, math, os, random
from mathutils import Vector
random.seed(12)
ROOT=os.path.abspath(os.environ.get('CAMPUSEATS_MODEL_OUTPUT',os.path.join(os.path.dirname(__file__),'../../frontend/static/models')))
# Start from a clean scene so Blender's default cube never enters the first asset.
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
MATERIALS={}
def mat(color,metal=0,rough=.45):
    key=(color,metal,rough)
    if key in MATERIALS:return MATERIALS[key]
    m=bpy.data.materials.new(color); m.diffuse_color=(*tuple((int(color[i:i+2],16)/255)**2.2 for i in (1,3,5)),1); m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=m.diffuse_color;p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
    MATERIALS[key]=m
    return m
def obj(name,loc,scale,color,kind='cube',parent=None,metal=0):
    if kind=='sphere':bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=10,location=loc)
    elif kind=='cylinder':bpy.ops.mesh.primitive_cylinder_add(vertices=20,radius=1,depth=2,location=loc)
    elif kind=='torus':bpy.ops.mesh.primitive_torus_add(major_segments=24,minor_segments=8,major_radius=1,minor_radius=.045,location=loc)
    else:bpy.ops.mesh.primitive_cube_add(size=2,location=loc)
    o=bpy.context.object;o.name=name;o.scale=scale;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(mat(color,metal))
    if kind=='cube':
        b=o.modifiers.new('Soft manufactured edges','BEVEL');b.width=.035;b.segments=3;o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
    else:
        for p in o.data.polygons:p.use_smooth=True
    if parent:o.parent=parent
    return o
def rod(name,a,b,r=.015,color='#b9c9ce'):
    mid=(Vector(a)+Vector(b))/2;o=obj(name,mid,(r,r,(Vector(a)-Vector(b)).length/2),color,'cylinder',metal=.8);o.rotation_euler=(Vector(b)-Vector(a)).to_track_quat('Z','Y').to_euler();return o
def export(path):
    if os.environ.get('CAMPUSEATS_ASSET_FILTER') and not path.startswith(os.environ['CAMPUSEATS_ASSET_FILTER']):
        bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);return
    target=os.path.join(ROOT,path+'.glb');os.makedirs(os.path.dirname(target),exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=target+'.tmp.glb',export_format='GLB',export_yup=True);os.replace(target+'.tmp.glb',target);bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
def food(t):
    if t=='burger':
        for n,z,s,c in [('Bun base',.10,(.31,.31,.10),'#d5913b'),('Patty',.22,(.32,.32,.075),'#633021'),('Lettuce',.30,(.35,.32,.035),'#74ac37'),('Tomato',.34,(.30,.30,.035),'#df4f32'),('Bun crown',.44,(.33,.33,.14),'#e9aa51')]:obj(n,(0,0,z),s,c,'sphere')
        for i in range(18):
            a=random.random()*6.28;r=random.random()*.26;obj('Sesame',(math.cos(a)*r,math.sin(a)*r,.54-r*.1),(.018,.009,.007),'#fff0c5','sphere')
    elif t=='pizza':
        obj('Golden crust',(0,0,.055),(.37,.37,.055),'#cb813b','cylinder');obj('Mozzarella',(0,0,.12),(.335,.335,.018),'#ffcd65','cylinder')
        for i in range(8):
            a=i*2.4;r=.12 if i<3 else .25;obj('Pepperoni',(math.sin(a)*r,math.cos(a)*r,.145),(.058,.058,.012),'#bb382d','cylinder')
    elif t=='fries':
        obj('Red carton',(0,0,.19),(.20,.13,.18),'#e64c36')
        for i in range(16):obj('Crispy fry',((i%4-1.5)*.085,(i//4-1.5)*.065,.42+random.random()*.08),(.027,.026,.20),'#ffc75c').rotation_euler[1]=random.uniform(-.2,.2)
    elif t in ['drink','coffee']:
        obj('Cup',(0,0,.25),(.16,.16,.25),'#a86e4b' if t=='coffee' else '#d887ab','cylinder');obj('Lid',(0,0,.51),(.18,.18,.025),'#fff0d9','cylinder');rod('Straw',(.05,0,.52),(.10,0,.82),.018,'#f9dec0')
        if t=='drink':
            for i in range(12):obj('Boba pearl',(math.sin(i*2.4)*.13,math.cos(i*2.4)*.13,.065+random.random()*.08),(.028,.028,.028),'#302525','sphere')
    elif t=='cake':
        for z,c in [(.08,'#e8ba88'),(.17,'#fff1d7'),(.26,'#d79392'),(.35,'#fff2d9')]:obj('Cake layer',(0,0,z),(.23,.20,.045),c)
        obj('Strawberry',(0,0,.45),(.09,.08,.10),'#dc3e45','sphere')
    else:
        obj('Ceramic bowl',(0,0,.15),(.32,.32,.15),'#dce6d7','sphere');obj('Broth' if t=='noodles' else 'Rice',(0,0,.26),(.29,.29,.025),'#c59348' if t=='noodles' else '#fff2d9','cylinder')
        for i in range(12):
            a=i*2.4;r=random.random()*.24;obj('Topping',(math.sin(a)*r,math.cos(a)*r,.30),(.065,.035,.025),['#79a04b','#e7b763','#fff0b9'][i%3],'sphere')
        rod('Chopstick',(-.32,-.08,.35),(.32,.13,.38),.012,'#a66e3f');rod('Chopstick',(-.32,-.13,.35),(.32,.08,.38),.012,'#a66e3f')
for t in ['burger','pizza','fries','noodles','rice','drink','coffee','cake']:food(t);export('food/'+t)
def pivot(name,loc,parent=None):
    p=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(p);p.location=loc
    if parent:p.parent=parent
    return p

def cloth(name,rings,color,parent=None):
    """A continuous tailored surface, with round rectangular cross sections."""
    n=16;vertices=[]
    for z,rx,ry,cy in rings:
        for i in range(n):
            a=i*math.tau/n;c=math.cos(a);s=math.sin(a)
            vertices.append((math.copysign(abs(c)**.72,c)*rx,cy+math.copysign(abs(s)**.72,s)*ry,z))
    faces=[]
    for row in range(len(rings)-1):
        for i in range(n):faces.append((row*n+i,row*n+(i+1)%n,(row+1)*n+(i+1)%n,(row+1)*n+i))
    faces.extend([tuple(reversed(range(n))),tuple(range((len(rings)-1)*n,len(rings)*n))])
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces);mesh.materials.append(mat(color));o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o)
    if parent:o.parent=parent
    for p in mesh.polygons:p.use_smooth=True
    mod=o.modifiers.new('Tailored smooth surface','SUBSURF');mod.levels=1;mod.render_levels=1
    return o

for role,color,skin in [('player','#a8a7bb','#dca881'),('customer','#c78665','#c89572'),('customer-female','#9a85bc','#b68161'),('cashier','#558d80','#d6a17d'),('employee','#e3cba7','#e4b895')]:
    body=pivot('BodyRoot',(0,0,0))
    cloth('Hoodie',[(.85,.19,.12,0),(.88,.22,.15,0),(1.10,.245,.16,0),(1.32,.27,.16,0),(1.40,.235,.14,0),(1.45,.105,.10,0)],color,body)
    obj('Hoodie hem',(0,0,.87),(.215,.145,.035),color,parent=body)
    obj('Hood',(0,.08,1.42),(.18,.13,.09),color,'sphere',body)
    obj('Neck',(0,0,1.51),(.070,.072,.085),skin,'cylinder',body)
    obj('Head',(0,-.008,1.72),(.158,.137,.197),skin,'sphere',body)
    obj('Jaw',(0,-.018,1.63),(.124,.116,.095),skin,'sphere',body)
    hair='#30272b' if role!='customer-female' else '#46312d'
    obj('Hair',(0,.025,1.85),(.166,.142,.11),hair,'sphere',body)
    for x in [-.059,.059]:
        obj('Eye',(x,-.139,1.74),(.014,.011,.019),'#30282a','sphere',body)
        obj('Eye highlight',(x-.004,-.149,1.746),(.004,.003,.005),'#fff3dd','sphere',body)
        obj('Brow',(x,-.136,1.784),(.028,.009,.007),hair,'sphere',body)
    obj('Nose',(0,-.150,1.69),(.023,.026,.032),skin,'sphere',body)
    obj('Smile',(0,-.132,1.635),(.028,.009,.006),'#995e53','sphere',body)
    for x in [-.154,.154]:obj('Ear',(x,0,1.715),(.027,.027,.049),skin,'sphere',body)
    for i in range(5):obj('Hair fringe',((i-2)*.048,-.092,1.84+random.uniform(-.01,.01)),(.048,.058,.056),hair,'sphere',body)
    if role=='customer-female':
        obj('Long hair',(0,.105,1.70),(.155,.055,.20),hair,'sphere',body)
        obj('Hair tie',(0,.16,1.72),(.065,.065,.10),hair,'sphere',body)
    for side,x in [('Left',-.135),('Right',.135)]:
        leg=pivot(side+'Leg',(x,0,.92),body)
        cloth('Trouser thigh',[(0,.109,.114,0),(-.07,.112,.112,0),(-.33,.088,.09,0),(-.42,.084,.086,0)],'#343b4a',leg)
        knee=pivot(side+'Knee',(0,0,-.42),leg)
        obj('Knee joint',(0,0,0),(.084,.086,.075),'#343b4a','sphere',knee)
        cloth('Trouser shin',[(.025,.084,.086,0),(-.10,.082,.087,0),(-.34,.067,.076,0),(-.40,.069,.077,0)],'#343b4a',knee)
        ankle=pivot(side+'Ankle',(0,0,-.40),knee)
        obj('Sneaker',(0,-.048,-.023),(.092,.151,.065),'#eee5d5','sphere',ankle)
        obj('Shoe sole',(0,-.048,-.066),(.095,.154,.020),'#b6b4a6',parent=ankle)
        for ly in [-.04,-.075,-.11]:obj('Laces',(0,ly,.020),(.061,.006,.006),'#f9f1e4',parent=ankle)
        arm=pivot(side+'Arm',(x/abs(x)*.285,0,1.405),body)
        cloth('Upper sleeve',[(.035,.094,.095,0),(-.05,.096,.096,0),(-.24,.076,.08,0),(-.29,.074,.078,0)],color,arm)
        elbow=pivot(side+'Elbow',(0,0,-.29),arm)
        obj('Elbow joint',(0,0,0),(.073,.076,.070),color,'sphere',elbow)
        cloth('Lower sleeve',[(.02,.073,.076,0),(-.10,.068,.072,0),(-.25,.057,.063,0),(-.28,.057,.062,0)],color,elbow)
        wrist=pivot(side+'Wrist',(0,0,-.28),elbow)
        obj('Sleeve cuff',(0,0,.015),(.058,.063,.025),color,parent=wrist)
        obj(side+'Hand',(0,-.006,-.045),(.052,.043,.066),skin,'sphere',wrist)
        obj('Thumb',(-.045 if x<0 else .045,-.02,-.03),(.021,.026,.038),skin,'sphere',wrist)
    if role=='player':
        bag=obj('Backpack',(0,.20,1.16),(.205,.105,.255),'#303d35',parent=body);bag.modifiers[0].width=.07
        obj('Backpack pocket',(0,.305,1.07),(.151,.025,.105),'#465749',parent=body)
        obj('Backpack badge',(0,.334,1.13),(.035,.012,.03),'#ebbf7d',parent=body)
        for x in [-.18,.18]:obj('Backpack strap',(x,-.143,1.22),(.023,.018,.19),'#3f4d40',parent=body)
    else:
        obj('Hoodie pocket',(0,-.159,1.02),(.13,.013,.06),color,parent=body)
        for x in [-.045,.045]:obj('Hood drawstring',(x,-.145,1.33),(.006,.006,.08),'#eae2cf',parent=body)
    if role in ['employee','cashier']:
        obj('Apron',(0,-.17,1.03),(.19,.025,.255),'#eee5cf',parent=body)
        obj('Apron pocket',(0,-.201,1.03),(.09,.012,.065),'#d1c5a8',parent=body)
    export('characters/'+role)

# Detailed wire cart, modeled in forward -Y direction.
for x in [-.43,.43]:
    for y in [-.45,.43]:
        o=obj('Wheel', (x,y,.16),(.12,.065,.12),'#30343b','cylinder');o.rotation_euler[1]=math.pi/2
        rod('Caster',(x,y,.2),(x,y,.35),.035)
for z in [.38,.71,1.03]:
    for x in [-.49,.49]:rod('Basket frame',(x,-.61,z),(x,.42,z),.018)
    for y in [-.61,.42]:rod('Basket frame',(-.49,y,z),(.49,y,z),.018)
for x in [-.49+i*.098 for i in range(11)]:
    for y in [-.61,.42]:rod('Basket wire',(x,y,.40),(x,y,1.02),.008)
    rod('Basket floor',(x,-.61,.40),(x,.42,.40),.008)
for y in [-.61+i*.103 for i in range(11)]:
    for x in [-.49,.49]:rod('Basket wire',(x,y,.4),(x,y,1.02),.008)
for x in [-.44,.44]:
    rod('Chassis',(x,-.50,.28),(x,.55,.28),.025);rod('Handle support',(x,.4,.35),(x,.70,1.14),.024)
rod('Coral handle',(-.49,.70,1.14),(.49,.70,1.14),.045,'#ed7650');export('equipment/shopping-cart')
for name in ['checkout-counter','display-counter']:
    obj('Oak cabinet',(0,0,.55),(1.8,.55,.55),'#9a6244')
    for x in [-1.7+i*.14 for i in range(25)]:obj('Oak fluting',(x,-.56,.55),(.022,.022,.48),'#b78054')
    obj('Stone countertop',(0,0,1.14),(1.88,.64,.065),'#efe7d5')
    if name=='checkout-counter':
        obj('Terminal base',(.7,0,1.26),(.17,.16,.06),'#303f40');o=obj('Register',(.7,0,1.5),(.25,.055,.19),'#334c4c');o.rotation_euler[0]=-.2
    else:
        for x in [-1.75,1.75]:rod('Glass frame',(x,-.48,1.2),(x,-.48,1.85),.015)
        obj('Glass canopy',(0,-.1,1.83),(1.8,.48,.018),'#b5d7cb',metal=.4)
    export('equipment/'+name)
obj('Basket',(0,0,.18),(.4,.25,.18),'#c98148');export('equipment/shopping-basket')
obj('Tray',(0,0,.025),(.4,.28,.025),'#d2c1aa');export('equipment/food-tray')
# Furniture and lush decorative vegetation.
obj('Tabletop',(0,0,.83),(.8,.8,.055),'#cda477','cylinder');rod('Pedestal',(0,0,.05),(0,0,.80),.06,'#3a4945');obj('Table foot',(0,0,.04),(.35,.35,.04),'#3a4945','cylinder');export('environment/table')
obj('Seat',(0,0,.46),(.24,.24,.045),'#bd8959');obj('Backrest',(0,.22,.77),(.25,.04,.25),'#bd8959')
for x in [-.20,.20]:
    for y in [-.19,.19]:rod('Chair leg',(x,y,0),(x,y,.46),.025,'#344842')
export('environment/chair')
obj('Ceramic planter',(0,0,.35),(.40,.40,.35),'#e4d7bd','cylinder');obj('Soil',(0,0,.70),(.36,.36,.02),'#4d3829','cylinder')
for i in range(18):
    a=i*2.4;h=random.uniform(1.1,2.1);end=(math.sin(a)*.45,math.cos(a)*.45,h);rod('Stem',(0,0,.65),end,.018,'#486a37');o=obj('Leaf',end,(.13,.36,.045),['#4c783d','#779647','#3f6c45'][i%3],'sphere');o.rotation_euler=(.4,random.random(),-a)
export('environment/plant')
for name,color in [('burger-shop','#b95c37'),('pizza-shop','#b74d3e'),('noodle-shop','#537e65'),('dessert-shop','#93648c')]:
    obj('Feature wall',(0,1.7,1.9),(3.4,.10,1.9),color);obj('Canopy',(0,.3,3.3),(3.5,1.5,.10),'#e8d6b4')
    for x in [-3.35,3.35]:obj('Column',(x,.2,1.6),(.10,1.4,1.6),'#674a3c')
    export('environment/'+name)
# Distinct pizza portions and a complete meal, rather than relabeling one mesh.
def sector(name,r,z,h,color):
    ring=[(0,0)]+[(math.cos(-math.pi/6+i*math.pi/36)*r,math.sin(-math.pi/6+i*math.pi/36)*r) for i in range(13)]
    n=len(ring);verts=[(x,y,z+level*h) for level in [0,1] for x,y in ring]
    faces=[tuple(reversed(range(n))),tuple(range(n,n*2))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.materials.append(mat(color));o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o)
sector('Slice crust',.67,.02,.055,'#cb813b');sector('Slice cheese',.61,.078,.023,'#ffcd65')
for x,y in [(.25,0),(.47,-.11),(.48,.10)]:obj('Pepperoni',(x,y,.11),(.06,.06,.01),'#bb382d','cylinder')
export('food/pizza-slice')
food('pizza')
for o in list(bpy.context.scene.objects):o.scale*=.72;o.location*=.72;o.location.x-=.13
existing=set(bpy.context.scene.objects);food('drink')
for o in bpy.context.scene.objects:
    if o not in existing:o.scale*=.65;o.location*=.65;o.location.x+=.30;o.location.y+=.12
obj('Combo tray',(0,0,.015),(.43,.33,.015),'#d2c1aa');export('food/pizza-combo')
# Mall architecture uses game/world coordinates converted to Blender Z-up.
def architecture(name,w,h,d,color,x,y,z,glass=False):
    o=obj(name,(x,-z,y),(w/2,d/2,h/2),color,metal=.2 if glass else 0)
    if glass:
        material=o.data.materials[0];material.diffuse_color=(*material.diffuse_color[:3],.23);material.node_tree.nodes.get('Principled BSDF').inputs['Alpha'].default_value=.23;material.surface_render_method='DITHERED'
    return o
architecture('Back wall',38,8,.3,'#e7d8bd',0,4,-12.2)
for side in [-1,1]:
    # Tall windows separated by masonry piers along each side of the atrium.
    architecture('Side wall',.3,4.3,30,'#d8c6aa',side*19,2.15,2)
    for z in range(-12,16,4):
        architecture('Clerestory window',.055,3.5,3.7,'#9ecbd0',side*18.98,6.1,z,True)
        architecture('Window mullion',.14,3.7,.12,'#526d67',side*18.95,6.1,z+1.9)
        architecture('Atrium column',.16,7.5,.16,'#65766a',side*16,3.75,z)
        architecture('Gallery bracket',3.3,.16,.14,'#526d67',side*17,7.5,z)
    architecture('Upper gallery',2.2,.24,27,'#b79a76',side*17,4.5,0)
    architecture('Glass balustrade',.055,.9,27,'#abc5b9',side*15.9,5.08,0,True)
    architecture('Oak handrail',.08,.08,27,'#5c6457',side*15.9,5.55,0)
architecture('Rear gallery',34,.3,2.2,'#c3ac8c',0,4.5,-11)
architecture('Rear balustrade',32,.8,.05,'#abc5b9',0,5.05,-9.85,True)
architecture('Rear handrail',32,.07,.08,'#586d61',0,5.5,-9.85)
for z in range(-12,16,4):
    architecture('Skylight crossbeam',35,.13,.16,'#4e6762',0,8.2,z)
    for x in range(-16,17,4):architecture('Skylight mullion',.1,.09,4,'#718d84',x,8.25,z+2)
architecture('Skylight glass',34,.02,29,'#b6d1d3',0,8.3,0,True)
export('environment/food-mall')
for x in [-1.02,1.02]:
    architecture('Door glazing',1.94,2.9,.04,'#a6c7c4',x,1.48,0,True)
    for edge in [-.99,.99]:architecture('Door stile',.045,3,.07,'#5c7065',x+edge,1.5,0)
    architecture('Door handle',.035,.46,.08,'#d2be8c',x+(.8 if x<0 else -.8),1.45,.09)
architecture('Entrance lintel',4.2,.09,.12,'#5c7065',0,3.02,0)
export('environment/entrance')
print('CampusEats original GLB asset generation complete')
