import * as THREE from "three";
import { AssetManager } from "./game/core/AssetManager.js";
import { CartController } from "./game/cart/CartController.js";
import { CameraController } from "./game/camera/CameraController.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  NPCController,
  separateCrowd,
  yieldToShoppers,
} from "./game/npc/NPCController.js";
import { PlayerAnimations } from "./game/player/PlayerAnimations.js";
import { shops, products } from "./game/data/products.js";
const mat = (color, roughness = 0.55, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });
export async function createWorld(host, notify, onState) {
  const assets = new AssetManager(),
    scene = new THREE.Scene();
  scene.background = new THREE.Color("#b9cdd1");
  scene.fog = new THREE.Fog("#d6c9b6", 28, 70);
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 90),
    renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  const cameraRig = new CameraController(camera);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.28;
  room.dispose();
  pmrem.dispose();
  host.appendChild(renderer.domElement);
  let disposed = false,
    paused = false,
    raf,
    elapsed = 0,
    angle = 0.12,
    pitch = 3.9,
    dragging = false,
    lastX = 0,
    lastY = 0,
    carry = null,
    transfer = null,
    pickUntil = 0,
    nearby = null,
    cartItems = [],
    navigation = null;
  const colliders = [],
    owned = [],
    actors = [],
    foodSpots = [];
  const addBox = (w, h, d, color, x, y, z, material) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      material || mat(color),
    );
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };
  function solid(x, z, w, d) {
    colliders.push({ x, z, w: w / 2 + 0.38, d: d / 2 + 0.38 });
  }
  function sign(
    text,
    x,
    y,
    z,
    width = 4,
    color = "#fff1d7",
    bg = "#263f36",
    height = 0.65,
  ) {
    const c = document.createElement("canvas");
    c.width = 1024;
    c.height = Math.max(96, Math.round((1024 * height) / width));
    const ctx = c.getContext("2d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1024, 192);
    ctx.fillStyle = color;
    ctx.font = "700 91px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.floor(c.height * 0.54)}px sans-serif`;
    ctx.fillText(text, 512, c.height * 0.53, 960);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }),
    );
    m.position.set(x, y, z);
    scene.add(m);
    owned.push(t);
    return m;
  }
  scene.add(new THREE.HemisphereLight("#fff1db", "#75816c", 2.05));
  const sunlight = new THREE.DirectionalLight("#ffe5c1", 1.65);
  sunlight.position.set(-8, 15, 8);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(1024, 1024);
  Object.assign(sunlight.shadow.camera, {
    left: -23,
    right: 23,
    top: 20,
    bottom: -20,
  });
  sunlight.shadow.bias = -0.00035;
  sunlight.shadow.normalBias = 0.025;
  sunlight.shadow.radius = 3;
  scene.add(sunlight);
  const floor = mat("#bfb5a2", 0.28, 0.18);
  addBox(38, 0.25, 32, null, 0, -0.15, 0, floor);
  const tileGeo = new THREE.BoxGeometry(1.97, 0.025, 1.97),
    tileMats = ["#d9d0bd", "#d2c9b8", "#ccc5b4", "#e3d9c4"].map((c) =>
      mat(c, 0.28, 0.12),
    );
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = 256;
  textureCanvas.height = 256;
  const tx = textureCanvas.getContext("2d");
  tx.fillStyle = "#f4efe4";
  tx.fillRect(0, 0, 256, 256);
  let seed = 472;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 12000; i++) {
    const v = 190 + random() * 60;
    tx.fillStyle = `rgba(${v},${v - 4},${v - 10},.13)`;
    tx.fillRect(random() * 256, random() * 256, 1 + random() * 2, 1);
  }
  for (let i = 0; i < 6; i++) {
    tx.beginPath();
    tx.moveTo(random() * 256, 0);
    tx.bezierCurveTo(
      random() * 256,
      70,
      random() * 256,
      180,
      random() * 256,
      256,
    );
    tx.strokeStyle = "#a99d8918";
    tx.lineWidth = 0.4;
    tx.stroke();
  }
  const stoneTexture = new THREE.CanvasTexture(textureCanvas);
  stoneTexture.colorSpace = THREE.SRGBColorSpace;
  tileMats.forEach((m) => (m.map = stoneTexture));
  owned.push(stoneTexture);
  for (let i = 0; i < 4; i++) {
    const mesh = new THREE.InstancedMesh(tileGeo, tileMats[i], 80);
    let n = 0;
    for (let x = -18; x <= 18; x += 2)
      for (let z = -14; z <= 14; z += 2) {
        if (((x + 18) / 2 + (z + 14) / 2) % 4 === i) {
          const matrix = new THREE.Matrix4().makeTranslation(x, 0, z);
          mesh.setMatrixAt(n++, matrix);
        }
      }
    mesh.count = n;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  const lightMat = new THREE.MeshBasicMaterial({ color: "#ffdaa0" });
  for (let z of [-3, 6]) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.5, 0.045, 8, 80),
      lightMat,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 6.4, z);
    scene.add(ring);
    for (const x of [-1.8, 1.8])
      addBox(0.025, 1.8, 0.025, "#4c5147", x, 7.3, z);
  }
  sign("CampusEats", 0, 4.45, -5.8, 5.6, "#f4d5a0", "#304a3f", 0.85);
  sign(
    "THE GOOD FOOD NEIGHBORHOOD",
    0,
    3.94,
    -5.79,
    5.6,
    "#d8dcbf",
    "#304a3f",
    0.24,
  );
  for (const x of [-2.1, 2.1])
    addBox(0.02, 2.4, 0.02, "#49594c", x, 5.95, -5.8);
  const glow = new THREE.MeshBasicMaterial({ color: "#e9bd7c" });
  addBox(5.64, 0.035, 0.035, null, 0, 4.9, -5.78, glow);
  addBox(5.64, 0.035, 0.035, null, 0, 3.8, -5.78, glow);
  // Warm pendant lights complement the Blender-exported skylight.
  for (let x of [-12, -4, 4, 12])
    for (let z of [0, 7]) {
      addBox(0.025, 1.35, 0.025, "#3d5145", x, 6.6, z);
      const shade = new THREE.Mesh(
        new THREE.ConeGeometry(0.42, 0.32, 24, 1, true),
        mat("#bc8c4d", 0.3, 0.6),
      );
      shade.position.set(x, 5.83, z);
      scene.add(shade);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), glow);
      bulb.position.set(x, 5.73, z);
      scene.add(bulb);
    }

  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = 64;
  shadowCanvas.height = 64;
  const shadowContext = shadowCanvas.getContext("2d"),
    gradient = shadowContext.createRadialGradient(32, 32, 2, 32, 32, 32);
  gradient.addColorStop(0, "rgba(32,29,21,.32)");
  gradient.addColorStop(0.4, "rgba(32,29,21,.15)");
  gradient.addColorStop(1, "rgba(32,29,21,0)");
  shadowContext.fillStyle = gradient;
  shadowContext.fillRect(0, 0, 64, 64);
  const contactTexture = new THREE.CanvasTexture(shadowCanvas);
  owned.push(contactTexture);
  const contactGeometry = new THREE.PlaneGeometry(1, 1);
  const contactMaterial = new THREE.MeshBasicMaterial({
    map: contactTexture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  function contact(root, width = 1, depth = 1) {
    const plane = new THREE.Mesh(contactGeometry, contactMaterial);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0.025;
    plane.scale.set(width, depth, 1);
    plane.renderOrder = 1;
    root.add(plane);
  }
  async function model(path, x = 0, y = 0, z = 0, scale = 1) {
    const m = await assets.load(path);
    m.position.set(x, y, z);
    m.scale.setScalar(scale);
    scene.add(m);
    if (path === "environment/food-mall")
      m.traverse((n) => {
        if (n.isMesh) n.castShadow = false;
      });
    if (path.startsWith("environment/"))
      cameraRig.register(m, { soft: path === "environment/plant" });
    if (
      path === "equipment/display-counter" ||
      path === "equipment/checkout-counter"
    )
      cameraRig.register(m);
    if (path === "environment/plant") contact(m, 1.25, 1.25);
    if (path === "environment/table") contact(m, 1.5, 1.5);
    if (path.startsWith("characters/")) contact(m, 0.8, 0.66);
    return m;
  }
  const paths = [
    ...["player", "customer", "customer-female", "cashier", "employee"].map(
      (x) => "characters/" + x,
    ),
    ...[
      "burger",
      "fries",
      "pizza",
      "pizza-slice",
      "pizza-combo",
      "noodles",
      "rice",
      "drink",
      "coffee",
      "cake",
    ].map((x) => "food/" + x),
    ...[
      "shopping-cart",
      "checkout-counter",
      "display-counter",
      "shopping-basket",
      "food-tray",
    ].map((x) => "equipment/" + x),
    ...[
      "plant",
      "table",
      "chair",
      "food-mall",
      "entrance",
      ...shops.map((s) => s.model),
    ].map((x) => "environment/" + x),
  ];
  try {
    await Promise.all(paths.map((p) => assets.load(p)));
  } catch (error) {
    assets.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    throw error;
  }
  if (disposed) return;
  await model("environment/food-mall");
  await model("environment/entrance", 0, 0, 14.5);
  for (const shop of shops) {
    await model("environment/" + shop.model, shop.x, 0, shop.z);
    solid(shop.x, shop.z - 1.7, 6.8, 0.2);
    const counterLight = new THREE.PointLight(shop.color, 7.5, 7, 2);
    counterLight.position.set(shop.x, 2.4, shop.z + 1.2);
    scene.add(counterLight);
    sign(
      shop.name,
      shop.x,
      2.95,
      shop.z + 0.23,
      5.8,
      shop.color,
      "#253a31",
      0.74,
    );
    sign(
      shop.subtitle,
      shop.x,
      2.42,
      shop.z + 0.24,
      5.2,
      "#f5ead4",
      "#253a31",
      0.25,
    );
    for (const dx of [-2.25, 2.25]) {
      const counter = await model(
        "equipment/display-counter",
        shop.x + dx,
        0,
        shop.z + 0.5,
        0.94,
      );
      counter.scale.x = 0.62;
      solid(shop.x + dx, shop.z + 0.5, 2.4, 1.3);
      addBox(
        2.35,
        0.035,
        0.035,
        null,
        shop.x + dx,
        0.23,
        shop.z + 1.1,
        new THREE.MeshBasicMaterial({ color: shop.color }),
      );
    }
    for (let j = -1; j <= 1; j++) {
      const menu = sign(
        j === -1
          ? "FRESH DAILY"
          : j === 0
            ? shop.icon + "  HOUSE FAVORITES"
            : "MADE WITH LOVE",
        shop.x + j * 1.95,
        2.02,
        shop.z - 1.4,
        1.55,
        "#f4e4b8",
        shop.wall,
        0.55,
      );
      menu.rotation.x = -0.08;
    }
    const staff = await model(
      "characters/employee",
      shop.x + 1.15,
      0,
      shop.z - 0.6,
    );
    actors.push({
      mesh: staff,
      staff: true,
      shop,
      animations: new PlayerAnimations(staff),
    });
    const ps = products.filter((p) => p.shop === shop.id);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i],
        x =
          shop.x + (ps.length === 3 ? [-2.85, -1.65, 2.4][i] : [-2.4, 2.4][i]);
      await model("food/" + p.type, x, 1.25, shop.z + 0.72, 1.12);
      sign(
        "$" + p.price.toFixed(2),
        x,
        1.02,
        shop.z + 1.12,
        1.03,
        "#fff4d9",
        "#35433b",
        0.31,
      );
      foodSpots.push({ ...p, x, z: shop.z + 2.2, shopName: shop.name });
    }
    for (let x of [shop.x - 2.3, shop.x + 2.3]) {
      addBox(0.07, 0.45, 0.07, "#443f33", x, 2.05, shop.z + 0.7);
      const lamp = new THREE.Mesh(
        new THREE.ConeGeometry(0.25, 0.2, 16),
        mat("#d5ab62", 0.3, 0.6),
      );
      lamp.position.set(x, 1.92, shop.z + 0.7);
      scene.add(lamp);
    }
  }
  const tables = [
    [-11, 1],
    [-6, 5],
    [-12, 8],
    [7, 1],
    [11, 8],
  ];
  for (const [x, z] of tables) {
    await model("environment/table", x, 0, z);
    solid(x, z, 1.6, 1.6);
    for (const side of [-1, 1]) {
      const c = await model("environment/chair", x + side * 1.1, 0, z);
      c.rotation.y = (-side * Math.PI) / 2;
      solid(x + side * 1.1, z, 0.48, 0.48);
    }
    await model("food/coffee", x, 0.9, z, 0.7);
  }
  for (const [x, z, side] of [
    [-11, 1, -1],
    [11, 8, 1],
  ]) {
    const sitter = await model(
      "characters/customer-female",
      x + side * 1.1,
      0,
      z,
    );
    sitter.rotation.y = (-side * Math.PI) / 2;
    const body = sitter.getObjectByName("BodyRoot");
    if (body) body.position.y = -0.44;
    for (const leg of ["Left", "Right"]) {
      sitter.getObjectByName(leg + "Leg").rotation.x = -Math.PI / 2;
      sitter.getObjectByName(leg + "Knee").rotation.x = Math.PI / 2;
      sitter.getObjectByName(leg + "Arm").rotation.x = -0.3;
      sitter.getObjectByName(leg + "Elbow").rotation.x = -0.9;
    }
    actors.push({ mesh: sitter, seated: true });
  }
  for (const [x, z] of [
    [-16, -5],
    [-8, -5],
    [0, -5],
    [8, -5],
    [16, -5],
    [-16, 6],
    [16, 7],
    [-4, 10],
    [6, 11],
  ]) {
    await model("environment/plant", x, 0, z, 1.15);
    solid(x, z, 0.9, 0.9);
  }
  // Green upper gallery foliage.
  for (let x = -15; x <= 15; x += 3)
    await model("environment/plant", x, 4.55, -10.5, 0.65);
  const checkout = { x: 12, z: 3 };
  await model("equipment/checkout-counter", 12, 0, 3);
  solid(12, 3, 3.8, 1.3);
  await model("characters/cashier", 12, 0, 1.7);
  sign("CHECKOUT  →", 12, 2.8, 3.1, 4.1, "#d2f5ed", "#345f53", 0.65);

  sign("EXIT  /  SEE YOU SOON", 0, 3.3, 14.4, 4.6, "#ceefbb", "#44604b", 0.5);
  const player = new THREE.Group();
  player.position.set(0, 0, 7);
  scene.add(player);
  const avatar = await assets.load("characters/player");
  avatar.rotation.y = Math.PI;
  player.add(avatar);
  contact(player, 0.9, 0.75);
  const cart = new THREE.Group();
  const cartModel = await assets.load("equipment/shopping-cart");
  // Blender's cart faces +Z; the player pushes toward local -Z.
  cartModel.rotation.y = Math.PI;
  cart.add(cartModel);
  cart.position.set(0, 0, 5.65);
  scene.add(cart);
  const cartController = new CartController(cart, colliders);
  cartController.sync(player, 0);
  contact(cart, 1.25, 1.65);
  const playerAnimations = new PlayerAnimations(avatar, { pushing: true });
  const sharedCrowd = { queue: [] };
  for (let i = 0; i < 9; i++) {
    const mesh = await model(
      "characters/" + (i % 2 ? "customer-female" : "customer"),
      2 + (i % 3) * 0.7,
      0,
      8 + Math.floor(i / 3) * 1.1,
    );
    const controller = new NPCController(mesh, i, sharedCrowd);
    const shirtColors = [
      "#64829a",
      "#bb765c",
      "#84986d",
      "#a17b99",
      "#c29c66",
      "#577d79",
      "#aa8584",
      "#7b879a",
      "#937958",
    ];
    const shirtMaterial = new Map();
    mesh.traverse((n) => {
      if (!n.isMesh) return;
      const material = n.material;
      if (material.name.startsWith(i % 2 ? "#9a85bc" : "#c78665")) {
        if (!shirtMaterial.has(material.uuid)) {
          const copy = material.clone();
          copy.color.set(shirtColors[i]);
          shirtMaterial.set(material.uuid, copy);
        }
        n.material = shirtMaterial.get(material.uuid);
      }
    });
    mesh.scale.setScalar(
      [0.97, 1.02, 0.94, 1.04, 1, 0.96, 1.01, 0.98, 1.03][i],
    );
    const start = [3, 2, 3, 3, 6, 7, 8, 9, 0][i];
    mesh.position.set(controller.route[start].x, 0, controller.route[start].z);
    controller.routeIndex = start;
    actors.push({ mesh, controller, animations: new PlayerAnimations(mesh) });
  }
  const keys = new Set(),
    velocity = new THREE.Vector2();
  const down = (e) => {
    if (paused || e.target?.closest?.("input,textarea,select")) return;
    keys.add(e.key.toLowerCase());
    if (
      ["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(
        e.key.toLowerCase(),
      )
    )
      e.preventDefault();
  };
  const up = (e) => keys.delete(e.key.toLowerCase());
  const blur = () => {
    keys.clear();
    dragging = false;
  };
  const pointerDown = (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    renderer.domElement.setPointerCapture(e.pointerId);
  };
  const pointerMove = (e) => {
    if (!dragging || paused) return;
    angle -= (e.clientX - lastX) * 0.005;
    pitch = THREE.MathUtils.clamp(pitch + (e.clientY - lastY) * 0.012, 2.2, 7);
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const pointerUp = () => (dragging = false);
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  window.addEventListener("blur", blur);
  renderer.domElement.addEventListener("pointerdown", pointerDown);
  renderer.domElement.addEventListener("pointermove", pointerMove);
  renderer.domElement.addEventListener("pointerup", pointerUp);
  const resize = () => {
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  const blocked = (x, z) =>
    x < -17.5 ||
    x > 17.5 ||
    z < -11.7 ||
    z > 14.1 ||
    colliders.some((c) => Math.abs(x - c.x) < c.w && Math.abs(z - c.z) < c.d);
  const follow = new THREE.Vector3(),
    look = new THREE.Vector3();
  camera.position.set(1, 4.8, 13.7);
  let last = performance.now(),
    lastTag = "",
    slowFrames = 0,
    autoLow = false;
  // Sparse luminous navigation dots lie on the floor, leaving the scene readable.
  const markers = [];
  for (let i = 0; i < 15; i++) {
    const m = new THREE.Mesh(
      new THREE.CircleGeometry(0.1, 12),
      new THREE.MeshBasicMaterial({
        color: "#b3e7d7",
        transparent: true,
        opacity: 0.65,
      }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.045;
    m.visible = false;
    scene.add(m);
    markers.push(m);
  }
  function tick(now) {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const rawDt = Math.max(0.001, (now - last) / 1000);
    const dt = Math.min(rawDt, 0.25);
    last = now;
    if (rawDt > 0.09) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 1);
    if (slowFrames >= 5 && !autoLow) {
      renderer.setPixelRatio(0.65);
      renderer.shadowMap.enabled = false;
      autoLow = true;
    }
    if (!paused) {
      elapsed += dt;
      let vx =
          (keys.has("d") || keys.has("arrowright") ? 1 : 0) -
          (keys.has("a") || keys.has("arrowleft") ? 1 : 0),
        vz =
          (keys.has("s") || keys.has("arrowdown") ? 1 : 0) -
          (keys.has("w") || keys.has("arrowup") ? 1 : 0);
      const dir = new THREE.Vector2(vx, vz);
      if (dir.length()) dir.normalize();
      dir.rotateAround(new THREE.Vector2(), -angle);
      dir.multiplyScalar(keys.has("shift") ? 5.5 : 3.1);
      velocity.lerp(dir, 1 - Math.exp(-dt * 9));
      const oldPosition = player.position.clone();
      const people = actors;
      const desiredYaw = cartController.steering(
        player.rotation.y,
        velocity.x,
        velocity.y,
        dt,
      );
      if (
        cartController.canSteer(
          player.position.x,
          player.position.z,
          player.rotation.y,
          desiredYaw,
          people,
        )
      )
        player.rotation.y = desiredYaw;
      const dx = velocity.x * dt,
        dz = velocity.y * dt,
        steps = Math.ceil(dt / 0.025);
      cartController.blocked = false;
      const canMove = (x, z) =>
        !blocked(x, z) &&
        !people.some(
          (a) =>
            Math.hypot(a.mesh.position.x - x, a.mesh.position.z - z) < 0.65,
        ) &&
        cartController.canPose(x, z, player.rotation.y, people);
      for (let step = 0; step < steps; step++) {
        if (canMove(player.position.x + dx / steps, player.position.z))
          player.position.x += dx / steps;
        else if (Math.abs(dx) > 0.001) cartController.blocked = true;
        if (canMove(player.position.x, player.position.z + dz / steps))
          player.position.z += dz / steps;
        else if (Math.abs(dz) > 0.001) cartController.blocked = true;
      }
      const travel = player.position.distanceTo(oldPosition),
        speed = travel / Math.max(dt, 0.001);
      const forwardTravel =
        -(player.position.x - oldPosition.x) * Math.sin(player.rotation.y) -
        (player.position.z - oldPosition.z) * Math.cos(player.rotation.y);
      const movementDirection = forwardTravel < -0.001 ? -1 : 1;
      const gripTargets = cartController.sync(
        player,
        travel * movementDirection,
      );
      playerAnimations.update(
        dt,
        speed,
        !!carry,
        elapsed < pickUntil,
        gripTargets,
        travel,
        movementDirection,
      );
      if (carry) {
        avatar.updateWorldMatrix(true, true);
        const hand = avatar.getObjectByName("RightWrist");
        if (hand) {
          hand.getWorldPosition(carry.mesh.position);
          carry.mesh.position.y -= 0.16;
          player.worldToLocal(carry.mesh.position);
        }
      }
      if (transfer) {
        transfer.time += dt;
        const t = Math.min(1, transfer.time / 0.42);
        const end = cart.localToWorld(
          new THREE.Vector3(
            ((transfer.index % 3) - 1) * 0.26,
            0.48 + Math.floor(transfer.index / 6) * 0.18,
            -0.28 + Math.floor((transfer.index % 6) / 3) * 0.34,
          ),
        );
        transfer.mesh.position.lerpVectors(transfer.start, end, t);
        transfer.mesh.position.y += Math.sin(t * Math.PI) * 0.5;
        if (t === 1) {
          cart.attach(transfer.mesh);
          transfer = null;
        }
      }
      const crowd = actors.filter((a) => a.controller).map((a) => a.controller),
        obstacles = cartController.obstacles(player);
      for (const a of actors) {
        if (a.seated) continue;
        if (a.staff) {
          a.mesh.rotation.y = THREE.MathUtils.clamp(
            Math.atan2(
              player.position.x - a.mesh.position.x,
              player.position.z - a.mesh.position.z,
            ),
            -0.6,
            0.6,
          );
          a.animations?.update(dt, 0);
          continue;
        }
        const old = a.mesh.position.clone(),
          npcSpeed = a.controller.update(dt, blocked, crowd, obstacles);
        a.animations.update(
          dt,
          npcSpeed,
          false,
          false,
          null,
          a.mesh.position.distanceTo(old),
        );
      }
      separateCrowd(crowd, blocked, obstacles);
      yieldToShoppers(crowd, blocked, obstacles);
    }
    scene.updateMatrixWorld(true);
    cameraRig.update(player, angle, pitch, dt);
    let action = null;
    let best = 1.8;
    for (const food of foodSpots) {
      const d = Math.hypot(
        food.x - player.position.x,
        food.z - player.position.z,
      );
      if (d < best) {
        best = d;
        action = {
          kind: "food",
          item: food,
          label: "Pick up " + food.name,
          detail:
            food.shopName +
            " · $" +
            food.price.toFixed(2) +
            " · Freshly made, just for you.",
        };
      }
    }
    if (Math.hypot(player.position.x - 12, player.position.z - 4.3) < 2.3)
      action = {
        kind: "checkout",
        label: "Talk to the cashier",
        detail: "Ready when you are.",
      };
    if (player.position.z > 12.2 && Math.abs(player.position.x) < 2.5)
      action = {
        kind: "exit",
        label: "Leave CampusEats",
        detail: "See you again soon.",
      };
    if (!action) {
      for (const a of actors) {
        if (
          a.staff &&
          Math.hypot(
            player.position.x - a.mesh.position.x,
            player.position.z - a.mesh.position.z,
          ) < 2.1
        )
          action = {
            kind: "staff",
            label: "Say hello",
            detail: a.shop.name + " · Your neighborhood kitchen",
            shop: a.shop.name,
          };
      }
    }
    if (carry)
      action = {
        kind: "place",
        label: "Place " + carry.product.name + " in cart",
        detail: "Q to place · E to return",
        item: carry.product,
      };
    nearby = action;
    const tag = JSON.stringify(action);
    if (tag !== lastTag) {
      lastTag = tag;
      notify(action);
    }
    if (navigation) {
      const dest =
        navigation === "checkout"
          ? { x: 12, z: 4.7 }
          : shops.find((s) => s.id === navigation);
      if (dest) {
        for (let i = 0; i < markers.length; i++) {
          const t = (i + 1) / markers.length;
          markers[i].visible = true;
          markers[i].position.x = THREE.MathUtils.lerp(
            player.position.x,
            dest.x,
            t,
          );
          markers[i].position.z = THREE.MathUtils.lerp(
            player.position.z,
            dest.z + (navigation === "checkout" ? 0 : 2.7),
            t,
          );
        }
      }
    } else markers.forEach((m) => (m.visible = false));
    onState?.({
      x: player.position.x,
      z: player.position.z,
      angle: player.rotation.y,
      location:
        (player.position.z < -5.2
          ? shops.find((s) => Math.abs(s.x - player.position.x) < 3.8)?.name
          : null) || "The Atrium",
      nearbyShop:
        player.position.z < -4
          ? shops.find((s) => Math.abs(s.x - player.position.x) < 3.8)?.id
          : null,
      cameraFaded: cameraRig.faded,
      cameraDistance: cameraRig.distance,
      cartBlocked: cartController.blocked,
      npcSpacing: Math.min(
        ...actors
          .filter((a) => a.controller)
          .flatMap((a, i, all) =>
            all
              .slice(i + 1)
              .map((b) => a.mesh.position.distanceTo(b.mesh.position)),
          ),
      ),
      distance: Math.hypot(player.position.x - 12, player.position.z - 4.3),
      fps: Math.round(1 / rawDt),
      autoLow,
    });

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);
  return {
    getAction: () => nearby,
    setPaused(v) {
      paused = v;
      keys.clear();
      velocity.set(0, 0);
    },
    navigate(id) {
      navigation = id;
    },
    async pickup(product) {
      if (carry || transfer || cartItems.length >= 18) return false;
      const mesh = await assets.load("food/" + product.type);
      if (carry || disposed) return false;
      mesh.scale.setScalar(0.64);
      player.add(mesh);
      mesh.position.set(-0.36, 1.0, -0.45);
      carry = { mesh, product };
      pickUntil = elapsed + 0.45;
      return true;
    },
    place() {
      if (!carry || transfer) return false;
      const { mesh, product } = carry;
      scene.attach(mesh);
      transfer = {
        mesh,
        start: mesh.position.clone(),
        time: 0,
        index: cartItems.length,
      };
      cartItems.push({ mesh, product });
      carry = null;
      return true;
    },
    returnItem() {
      if (!carry) return;
      player.remove(carry.mesh);
      carry = null;
    },
    remove(index) {
      const [item] = cartItems.splice(index, 1);
      if (item) {
        item.mesh.removeFromParent();
        if (transfer?.mesh === item.mesh) transfer = null;
      }
      cartItems.forEach((entry, i) => {
        if (transfer?.mesh === entry.mesh) {
          transfer.index = i;
        } else
          entry.mesh.position.set(
            ((i % 3) - 1) * 0.26,
            0.48 + Math.floor(i / 6) * 0.18,
            -0.28 + Math.floor((i % 6) / 3) * 0.34,
          );
      });
    },
    clearCart() {
      if (transfer) {
        transfer.mesh.removeFromParent();
        transfer = null;
      }
      for (const item of cartItems) item.mesh.removeFromParent();
      cartItems = [];
    },
    setQuality(low) {
      autoLow = false;
      slowFrames = 0;
      renderer.setPixelRatio(low ? 0.65 : Math.min(devicePixelRatio, 1.5));
      renderer.shadowMap.enabled = !low;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      playerAnimations.dispose();
      actors.forEach((a) => a.animations?.dispose());
      cameraRig.dispose();
      environment.dispose();
      observer.disconnect();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      const geometries = new Set(),
        materials = new Set();
      scene.traverse((n) => {
        if (n.geometry) geometries.add(n.geometry);
        if (n.material)
          for (const m of Array.isArray(n.material) ? n.material : [n.material])
            materials.add(m);
      });
      for (const g of geometries) g.dispose();
      for (const m of materials) {
        m.map?.dispose();
        m.dispose();
      }
      owned.forEach((t) => t.dispose());
      assets.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
