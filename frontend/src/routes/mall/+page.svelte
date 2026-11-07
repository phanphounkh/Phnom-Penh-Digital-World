<script>
  // Legacy CampusEats food court (single-player). Kept working; it becomes the template for
  // shop interiors in Phase 4. Its stylesheet is global, so links out of it reload the page.
  import "$lib/legacy-mall/mall.css";
  import { onMount } from "svelte";
  import { focusDialog } from "$lib/actions/focusDialog.js";
  import {
    ShoppingCart,
    ShoppingBag,
    MapPin,
    ArrowUpRight,
    ArrowRight,
    X,
    Settings2,
    Volume2,
    VolumeX,
    ReceiptText,
    Star,
    Check,
    Compass,
    Gamepad2,
    ChevronRight,
    LogOut,
    Navigation,
    Leaf,
    Plus,
    Minus,
    CircleHelp,
  } from "lucide-svelte";
  import MissionPanel from "$lib/components/game/MissionPanel.svelte";
  import MiniMap from "$lib/components/game/MiniMap.svelte";
  import InventoryBar from "$lib/components/game/InventoryBar.svelte";
  import { shops, products, money } from "$lib/game/data/products.js";
  import {
    cartStore,
    totalCents,
    groupItems,
    makeReceipt,
    newItemId,
  } from "$lib/stores/cartStore.js";
  let viewport,
    world,
    action = null,
    modal = "",
    held = null,
    loading = true,
    error = "",
    message = "",
    orders = [],
    receipt = null,
    nav = null,
    sound = false,
    lowQuality = false,
    busy = false,
    ended = false,
    help = false;
  let position = {
    x: 0,
    z: 7,
    angle: 0,
    location: "The Atrium",
    distance: 12,
    fps: 60,
  };
  let visited = [],
    paid = false,
    toastTimer,
    audioContext,
    audioNodes = [];
  $: total = totalCents($cartStore) / 100;
  $: points = orders.reduce((sum, o) => sum + o.points, 0);
  $: if (world) world.setPaused(!!modal || ended);
  onMount(() => {
    let dead = false;
    try {
      orders = JSON.parse(localStorage.getItem("campuseats-orders") || "[]");
      if (!Array.isArray(orders)) orders = [];
    } catch {
      orders = [];
    }
    paid = orders.length > 0;
    import("$lib/world.js")
      .then(async ({ createWorld }) => {
        if (dead) return;
        const instance = await createWorld(
          viewport,
          (a) => {
            action = a;
            if (a?.item?.shop && !visited.includes(a.item.shop))
              visited = [...visited, a.item.shop];
          },
          (s) => {
            position = s;
            if (s.autoLow) lowQuality = true;
          },
        );
        if (dead) {
          instance?.dispose();
          return;
        }
        world = instance;
        loading = false;
      })
      .catch((e) => {
        console.error(e);
        error = "The 3D world could not load. Please reload to try again.";
        loading = false;
      });
    const key = (e) => {
      if (e.repeat) return;
      if (e.key === "Escape") {
        if (!ended) modal = modal ? "" : "settings";
        return;
      }
      if (modal || ended || loading) return;
      if (e.key.toLowerCase() === "e") {
        e.preventDefault();
        interact();
      }
      if (e.key.toLowerCase() === "q") {
        e.preventDefault();
        place();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      dead = true;
      window.removeEventListener("keydown", key);
      world?.dispose();
      clearTimeout(toastTimer);
      audioContext?.close();
    };
  });
  function toast(t) {
    message = t;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (message = ""), 3200);
  }
  async function interact() {
    if (!action || busy) return;
    if (action.kind === "food") {
      if ($cartStore.length >= 18) {
        toast("Your cart is full. Time for checkout!");
        return;
      }
      busy = true;
      const picked = await world.pickup(action.item);
      if (picked) {
        held = { ...action.item };
        toast("Freshly picked! Press Q to place it in your cart.");
      }
      busy = false;
    } else if (action.kind === "place") {
      world.returnItem();
      held = null;
      toast("Item returned. Take your time choosing.");
    } else if (action.kind === "checkout") modal = "checkout";
    else if (action.kind === "exit") modal = "exit";
    else if (action.kind === "staff")
      toast(action.shop + ": Welcome in! Everything is freshly made.");
  }
  function place() {
    if (!held || busy) return;
    if (world?.place()) {
      $cartStore = [...$cartStore, { ...held, uid: newItemId() }];
      toast(held.name + " added to your haul");
      held = null;
    }
  }
  function navigate(id) {
    nav = id;
    world?.navigate(id);
    modal = "";
    toast(
      id === "checkout"
        ? "Follow the mint trail to the cashier."
        : "Follow the mint trail to " +
            shops.find((s) => s.id === id)?.name +
            ".",
    );
  }
  function checkout() {
    if (action?.kind === "checkout") modal = "checkout";
    else navigate("checkout");
  }
  function remove(uid) {
    const index = $cartStore.findIndex((i) => i.uid === uid);
    if (index < 0) return;
    world?.remove(index);
    $cartStore = $cartStore.filter((i) => i.uid !== uid);
  }
  function pay() {
    if (!$cartStore.length || action?.kind !== "checkout" || busy) return;
    busy = true;
    receipt = makeReceipt($cartStore, orders.length + 1);
    const purchased = new Set(receipt.items.map((i) => i.uid));
    $cartStore = $cartStore.filter((i) => !purchased.has(i.uid));
    world?.clearCart();
    orders = [...orders, receipt];
    try {
      localStorage.setItem("campuseats-orders", JSON.stringify(orders));
    } catch {
      toast("Receipt is available for this session; local storage is full.");
    }
    paid = true;
    modal = "success";
    nav = null;
    world?.navigate(null);
    busy = false;
    chime();
  }
  function chime() {
    if (!sound || !audioContext) return;
    for (const [i, f] of [523, 659, 784].entries()) {
      const oscillator = audioContext.createOscillator(),
        gain = audioContext.createGain();
      oscillator.frequency.value = f;
      gain.gain.setValueAtTime(0.025, audioContext.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        audioContext.currentTime + 0.5 + i * 0.12,
      );
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(audioContext.currentTime + i * 0.12);
      oscillator.stop(audioContext.currentTime + 0.55 + i * 0.12);
    }
  }
  function toggleSound() {
    sound = !sound;
    if (sound) {
      audioContext ??= new AudioContext();
      audioContext.resume();
      for (const f of [130.81, 196, 261.63]) {
        const o = audioContext.createOscillator(),
          g = audioContext.createGain();
        o.type = "sine";
        o.frequency.value = f;
        g.gain.value = 0.003;
        o.connect(g).connect(audioContext.destination);
        o.start();
        audioNodes.push(o);
      }
      chime();
    } else {
      audioNodes.forEach((o) => o.stop());
      audioNodes = [];
    }
  }
  function leave() {
    held = null;
    world?.returnItem();
    $cartStore = [];
    world?.clearCart();
    nav = null;
    world?.navigate(null);
    modal = "";
    ended = true;
  }
  function touch(key, down) {
    window.dispatchEvent(
      new KeyboardEvent(down ? "keydown" : "keyup", { key, bubbles: true }),
    );
  }
</script>

<svelte:head
  ><title>CampusEats — A little world of good food</title><meta
    name="description"
    content="Step inside CampusEats. Explore four neighborhood kitchens, pick up your favorites, and roll to checkout in a playable 3D food court."
  /></svelte:head
>
<div class="game">
  <div
    class="world"
    data-x={position.x}
    data-z={position.z}
    data-fps={position.fps}
    data-camera-faded={position.cameraFaded || 0}
    data-camera-distance={position.cameraDistance || 6.8}
    data-npc-spacing={position.npcSpacing || 0}
    data-cart-blocked={position.cartBlocked ? "true" : "false"}
    data-nearby-shop={position.nearbyShop || ""}
    bind:this={viewport}
  ></div>
  <div class="vignette"></div>
  <div class="hud" inert={!!modal || ended || loading}>
    <header class="topbar">
      <a class="brand" href="/" data-sveltekit-reload aria-label="Phnom Penh Digital World home"
        ><span class="brand-icon">🍟</span><span class="brand-copy"
          ><strong>Campus<span>Eats</span><sup>®</sup></strong><small
            >A LITTLE WORLD OF GOOD FOOD</small
          ></span
        ></a
      >
      <nav aria-label="Main navigation">
        <button
          class:active={!modal || modal === "shops"}
          onclick={() => {
            modal = "";
            nav = null;
            world?.navigate(null);
          }}><Compass size={17} /> Explore</button
        ><button onclick={() => (modal = "shops")}
          ><ShoppingBag size={16} /> The shops
          <span class="nav-count">04</span></button
        ><button
          class:active={modal === "orders"}
          onclick={() => (modal = "orders")}
          ><ReceiptText size={16} /> My orders {#if orders.length}<span
              class="order-count">{orders.length}</span
            >{/if}</button
        >
      </nav>
      <div class="top-actions">
        <button class="points" onclick={() => (modal = "rewards")}
          ><Star size={16} /><b>{points}</b><span>pts</span></button
        >
        <div class="divider"></div>
        <button
          class="icon-button sound"
          aria-label={sound ? "Mute ambience" : "Enable ambience"}
          onclick={toggleSound}
          >{#if sound}<Volume2 size={18} />{:else}<VolumeX
              size={18}
            />{/if}</button
        ><button
          class="icon-button"
          aria-label="Open settings"
          onclick={() => (modal = "settings")}><Settings2 size={18} /></button
        ><button
          class="avatar"
          onclick={() => (modal = "help")}
          aria-label="Player information">J<span></span></button
        >
      </div>
    </header>
    <aside class="left-rail">
      <MiniMap {position} {navigate} target={nav} />
      <MissionPanel {visited} {paid} {points} />
    </aside>
    <div class="location-chip">
      <span class="location-dot"></span><MapPin size={13} /><span
        >{position.location}</span
      ><span class="location-separator">/</span><small>Campus Food Court</small>
    </div>
    <div class="world-caption">
      <span class="tiny-line"></span> A PLACE TO WANDER. A LOT TO TASTE.
    </div>
    <div class="controls-area">
      <button class="control-toggle glass" onclick={() => (help = !help)}
        ><Gamepad2 size={16} /><span>Make yourself at home</span><span
          class="controls-key">?</span
        ></button
      >{#if help}<div class="controls-card glass">
          <div>
            <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>Move</span>
          </div>
          <div><kbd>Shift</kbd><span>Run</span></div>
          <div><kbd>Drag</kbd><span>Look around</span></div>
          <div><kbd>E</kbd><span>Pick up / return / interact</span></div>
          <div><kbd>Q</kbd><span>Place in cart</span></div>
          <div><kbd>Esc</kbd><span>Menu</span></div>
        </div>{/if}<small class="build-label"
        ><span></span> FOOD WORLD <b>•</b> V0.2 ALPHA</small
      >
    </div>
    {#if action && !modal && !ended && !loading}<div class="interaction-wrap">
        <div class="interaction-meta">{action.detail}</div>
        <button
          class="interaction"
          onclick={action.kind === "place" ? place : interact}
          disabled={busy}
          ><kbd>{action.kind === "place" ? "Q" : "E"}</kbd><span
            >{action.label}</span
          ><ArrowRight size={15} /></button
        >{#if held}<small>Press E to return this item</small>{/if}
      </div>{/if}
    {#if !action && !modal && !loading && !ended}<div class="explore-hint">
        <span>W A S D</span> Wander a little. Find your favorite.
      </div>{/if}
    <div class="inventory-anchor">
      <InventoryBar cart={$cartStore} {held} inspect={() => (modal = "cart")} />
    </div>
    <aside class="cart-card glass">
      <button class="cart-heading" onclick={() => (modal = "cart")}
        ><span class="cart-icon"
          ><ShoppingCart size={20} /><i>{$cartStore.length}</i></span
        ><span
          >Your little haul<small
            >{$cartStore.length
              ? "Made with good taste"
              : "Something delicious is waiting"}</small
          ></span
        ><strong>{money(total)}</strong></button
      ><button class="checkout-button" onclick={checkout}
        ><span
          >{nav === "checkout"
            ? "Follow the mint trail"
            : action?.kind === "checkout"
              ? "Pay at checkout"
              : "Let’s check out"}</span
        ><ArrowRight size={17} /></button
      >
      <div class="cart-caption">
        <span class="tiny-dot"></span>
        {action?.kind === "checkout"
          ? "You’re at the cashier"
          : `${Math.round(position.distance)} m to checkout`}<span
          >DEMO PAYMENT</span
        >
      </div>
    </aside>
    <div class="mobile-controls">
      <button
        aria-label="Move forward"
        onpointerdown={() => touch("w", true)}
        onpointerup={() => touch("w", false)}
        onpointerleave={() => touch("w", false)}>↑</button
      >
      <div>
        <button
          aria-label="Move left"
          onpointerdown={() => touch("a", true)}
          onpointerup={() => touch("a", false)}
          onpointerleave={() => touch("a", false)}>←</button
        ><button
          aria-label="Move backward"
          onpointerdown={() => touch("s", true)}
          onpointerup={() => touch("s", false)}
          onpointerleave={() => touch("s", false)}>↓</button
        ><button
          aria-label="Move right"
          onpointerdown={() => touch("d", true)}
          onpointerup={() => touch("d", false)}
          onpointerleave={() => touch("d", false)}>→</button
        >
      </div>
    </div>
  </div>
  {#if message}<div class="toast" role="status">
      <Check size={15} />{message}
    </div>{/if}
  {#if loading || error}<div class="loading-screen">
      <span class="loading-brand">🍟</span>
      <h1>Campus<span>Eats</span></h1>
      <p>{error || "Warming up the kitchens…"}</p>
      {#if error}<button class="primary" onclick={() => location.reload()}
          >Reload world</button
        >{:else}<div class="loading-track"><span></span></div>
        <small>YOUR NEXT FAVORITE IS JUST AROUND THE CORNER</small>{/if}
    </div>{/if}
  {#if ended}<div class="overlay">
      <div
        class="dialog exit-screen"
        use:focusDialog
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        aria-label="Session ended"
      >
        <div class="modal-symbol">🍟</div>
        <div class="eyebrow">UNTIL NEXT TIME</div>
        <h2>That was a good little adventure.</h2>
        <p>
          Thanks for stopping by CampusEats. Your receipts will be right here
          when you come back.
        </p>
        <button
          class="primary"
          onclick={() => {
            ended = false;
          }}>Return to the food court <ArrowRight size={16} /></button
        ><button
          class="secondary"
          onclick={() => {
            ended = false;
            modal = "orders";
          }}>View my orders</button
        >
      </div>
    </div>{/if}
  {#if modal}<div
      class="overlay"
      role="presentation"
      onclick={(e) => {
        if (e.target === e.currentTarget) modal = "";
      }}
    >
      <div
        class="dialog"
        use:focusDialog={modal}
        role="dialog"
        aria-modal="true"
        aria-label={modal === "checkout" ? "Demo KHQR checkout" : modal}
        tabindex="-1"
      >
        <button
          class="close"
          onclick={() => (modal = "")}
          aria-label="Close dialog"><X size={18} /></button
        >
        {#if modal === "shops"}<div class="eyebrow">
            FOUR KITCHENS. ONE HAPPY PLACE.
          </div>
          <h2>Follow your cravings.</h2>
          <p>
            Pick a kitchen and follow the mint trail. Your next favorite is
            waiting at the counter.
          </p>
          <div class="shop-list">
            {#each shops as shop}<button onclick={() => navigate(shop.id)}
                ><span style={`background:${shop.color}25`}>{shop.icon}</span>
                <div>
                  <b>{shop.name}</b><small
                    >{products
                      .filter((p) => p.shop === shop.id)
                      .map((p) => p.name)
                      .join(" · ")}</small
                  >
                </div>
                <ArrowUpRight size={18} /></button
              >{/each}
          </div>
        {:else if modal === "cart" || modal === "checkout"}<div class="eyebrow">
            {modal === "checkout"
              ? "CAMPUS EATS / DEMO CHECKOUT"
              : "A COLLECTION OF GOOD THINGS"}
          </div>
          <h2>
            {modal === "checkout"
              ? "A little treat, all yours."
              : "Your little haul."}
          </h2>
          <p>
            {held
              ? `You’re carrying ${held.name}. Place it in the cart with Q when you return.`
              : modal === "checkout"
                ? "Fresh finds from your campus favorites."
                : "Everything in your cart, in one place."}
          </p>
          {#if $cartStore.length}<div class="cart-list">
              {#each $cartStore as item (item.uid)}<div class="order-row">
                  <span class="food-icon">{item.icon}</span>
                  <div>
                    <b>{item.name}</b><small>{item.shopName} · Qty 1</small>
                  </div>
                  <strong>{money(item.price)}</strong><button
                    aria-label={`Remove ${item.name}`}
                    onclick={() => remove(item.uid)}><Minus size={14} /></button
                  >
                </div>{/each}
            </div>
            <div class="total-row">
              <span>Total <small>{$cartStore.length} items</small></span><strong
                >{money(total)}</strong
              >
            </div>
            {#if modal === "checkout"}<div class="khqr">
                <div class="khqr-top">KHQR <span>DEMO</span></div>
                <div class="khqr-content">
                  <div
                    class="demo-qr"
                    aria-label="Decorative demo QR, not a real payment code"
                  >
                    {#each Array(81) as _, i}<i
                        class:dark={(i % 9 < 3 && Math.floor(i / 9) < 3) ||
                          (i % 9 > 5 && Math.floor(i / 9) < 3) ||
                          (i % 9 < 3 && Math.floor(i / 9) > 5) ||
                          (i * 13 + i * i) % 7 < 3}
                      ></i>{/each}
                  </div>
                  <div>
                    <b>CampusEats</b><strong>{money(total)}</strong><small
                      >Simulated payment only.<br />No money will be charged.</small
                    >
                  </div>
                </div>
              </div>
              <button
                class="primary"
                onclick={pay}
                disabled={busy || action?.kind !== "checkout"}
                >Simulate payment <ArrowRight size={16} /></button
              >{:else}<button class="primary" onclick={checkout}
                >Head to checkout <Navigation size={16} /></button
              >{/if}{:else}<div class="empty-state">
              <ShoppingCart size={38} /><b>Room for something delicious.</b>
              <p>
                Walk to a counter, press E to pick up, then Q to place it in
                your cart.
              </p>
            </div>
            <button class="primary" onclick={() => (modal = "")}
              >Keep exploring <ArrowRight size={16} /></button
            >{/if}
        {:else if modal === "success"}<div class="success-symbol">
            <Check size={32} />
          </div>
          <div class="eyebrow">A LITTLE MOMENT OF HAPPINESS</div>
          <h2>Good food, secured.</h2>
          <p>
            Demo order {receipt?.id} is complete. You earned
            <b>{receipt?.points} food points</b>. No real payment was made.
          </p>
          <button class="primary" onclick={() => (modal = "")}
            >Continue shopping <ArrowRight size={16} /></button
          ><button
            class="secondary"
            onclick={() =>
              navigate(
                shops.find((s) => !visited.includes(s.id))?.id || "sweet",
              )}>Visit another kitchen <Compass size={16} /></button
          ><button class="secondary" onclick={() => (modal = "receipt")}
            >View receipt <ReceiptText size={16} /></button
          ><button class="text-button" onclick={() => (modal = "exit")}
            >Exit CampusEats World</button
          >
        {:else if modal === "receipt"}<div class="eyebrow">
            CAMPUS EATS / DEMO RECEIPT
          </div>
          <h2>Thanks for your good taste.</h2>
          {#if receipt}<div class="receipt-meta">
              <span>{receipt.id}</span><span
                >{new Date(receipt.date).toLocaleString()}</span
              >
            </div>
            {#each groupItems(receipt.items) as item}<div class="receipt-row">
                <span>{item.quantity} × {item.name}</span><b
                  >{money(item.price * item.quantity)}</b
                >
              </div>{/each}
            <div class="total-row">
              <span>Total paid</span><strong>{money(receipt.total)}</strong>
            </div>
            <p class="demo-note">
              SIMULATED KHQR · NO REAL TRANSACTION
            </p>{/if}<button class="primary" onclick={() => (modal = "")}
            >Continue exploring <ArrowRight size={16} /></button
          >
        {:else if modal === "orders"}<div class="eyebrow">
            GOOD MEALS. HAPPY MEMORIES.
          </div>
          <h2>Your campus orders.</h2>
          {#if orders.length}<div class="orders-list">
              {#each [...orders].reverse() as order}<button
                  onclick={() => {
                    receipt = order;
                    modal = "receipt";
                  }}
                  ><ReceiptText size={20} />
                  <div>
                    <b>{order.id}</b><small
                      >{order.items.length} items · {new Date(
                        order.date,
                      ).toLocaleDateString()}</small
                    >
                  </div>
                  <strong>{money(order.total)}</strong><ChevronRight
                    size={16}
                  /></button
                >{/each}
            </div>{:else}<div class="empty-state">
              <ReceiptText size={38} /><b
                >Your first meal is a memory in the making.</b
              >
              <p>Finished demo orders and receipts will appear here.</p>
            </div>{/if}<button class="primary" onclick={() => (modal = "")}
            >Back to the food court</button
          >
        {:else if modal === "rewards"}<div class="modal-symbol">✧</div>
          <div class="eyebrow">GOOD TASTE GETS REWARDED</div>
          <h2>{points} little reasons to smile.</h2>
          <p>
            Earn 10 food points for every demo dollar spent. Complete your first
            meal, explore two kitchens, and collect 100 points to finish your
            campus mission.
          </p>
          <button class="primary" onclick={() => (modal = "")}
            >Find something delicious <ArrowRight size={16} /></button
          >
        {:else if modal === "settings"}<div class="eyebrow">
            MAKE YOURSELF AT HOME
          </div>
          <h2>Your world, your way.</h2>
          <button class="setting-row" onclick={toggleSound}
            ><span><Volume2 size={18} /> Soft ambient sound</span><b
              >{sound ? "On" : "Off"}</b
            ></button
          ><button
            class="setting-row"
            onclick={() => {
              lowQuality = !lowQuality;
              world?.setQuality(lowQuality);
            }}
            ><span><Leaf size={18} /> Graphics quality</span><b
              >{lowQuality ? "Performance" : "High"}</b
            ></button
          ><button class="setting-row" onclick={() => (modal = "help")}
            ><span><Gamepad2 size={18} /> How to play</span><ChevronRight
              size={16}
            /></button
          ><button class="secondary" onclick={() => (modal = "exit")}
            ><LogOut size={16} /> Exit the world</button
          ><button class="primary" onclick={() => (modal = "")}
            >Back to exploring <ArrowRight size={16} /></button
          >
        {:else if modal === "exit"}<div class="eyebrow">
            THERE’S ALWAYS MORE TO TASTE
          </div>
          <h2>Heading out?</h2>
          <p>
            Your receipts will be saved on this browser. {$cartStore.length ||
            held
              ? "Unpaid food and the item in your hand will be returned."
              : "Come back whenever you’re hungry for an adventure."}
          </p>
          <button class="primary" onclick={() => (modal = "")}
            >Stay a little longer</button
          ><button class="secondary" onclick={leave}
            >Exit CampusEats World <LogOut size={16} /></button
          >
        {:else}<div class="eyebrow">WELCOME TO YOUR CAMPUS FOOD WORLD</div>
          <h2>Take a delicious little detour.</h2>
          <p>Four kitchens, plenty of good food, and nowhere to rush.</p>
          <div class="help-list">
            <p><kbd>W A S D</kbd> Walk · <kbd>Shift</kbd> Run</p>
            <p><kbd>Drag mouse</kbd> Rotate the camera</p>
            <p><kbd>E</kbd> Pick up food near a counter</p>
            <p><kbd>Q</kbd> Place the food into your cart</p>
            <p><kbd>E</kbd> Return the item you’re carrying</p>
            <p><kbd>Esc</kbd> Pause and open settings</p>
          </div>
          <p>
            Follow “Let’s check out” to find the cashier, then press E to start
            a demo KHQR payment. Nothing here charges real money.
          </p>
          <button class="primary" onclick={() => (modal = "")}
            >Let’s explore <ArrowRight size={16} /></button
          >{/if}
      </div>
    </div>{/if}
</div>
