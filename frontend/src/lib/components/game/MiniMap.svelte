<script>
  import { shops } from "$lib/game/data/products.js";
  let {
    position = { x: 0, z: 7, angle: 0 },
    navigate = () => {},
    target = null,
  } = $props();
</script>

<div class="mini-map">
  <div class="map-heading">
    <span class="live-dot"></span> CAMPUS FOOD COURT <span>01</span>
  </div>
  <svg
    viewBox="0 0 220 154"
    role="img"
    aria-label="Live food court map showing your location, four shops and checkout"
  >
    <defs
      ><pattern id="grid" width="15" height="15" patternUnits="userSpaceOnUse"
        ><path
          d="M 15 0 L 0 0 0 15"
          fill="none"
          stroke="#aeb8a4"
          stroke-width=".4"
          opacity=".2"
        /></pattern
      ></defs
    >
    <rect
      x="5"
      y="5"
      width="210"
      height="144"
      rx="8"
      fill="#273e36"
      stroke="#a5b29b"
      stroke-opacity=".3"
    />
    <rect x="5" y="5" width="210" height="144" rx="8" fill="url(#grid)" />
    {#each shops as shop, i}<g
        role="button"
        tabindex="0"
        aria-label={`Navigate to ${shop.name}`}
        aria-pressed={target === shop.id}
        onclick={() => navigate(shop.id)}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            navigate(shop.id);
          }
        }}
        ><rect
          x={14 + i * 49}
          y="14"
          width="44"
          height="27"
          rx="3"
          fill={shop.color}
          fill-opacity={position.nearbyShop === shop.id ? 0.55 : 0.25}
          stroke={shop.color}
          stroke-width={target === shop.id || position.nearbyShop === shop.id
            ? 2
            : 0.7}
        /><text x={36 + i * 49} y="32" text-anchor="middle" font-size="13"
          >{shop.icon}</text
        ></g
      >{/each}
    {#each [[45, 75], [76, 107], [165, 111]] as p}<circle
        cx={p[0]}
        cy={p[1]}
        r="9"
        fill="#a2b29a"
        fill-opacity=".17"
      /><circle
        cx={p[0]}
        cy={p[1]}
        r="5"
        fill="#a2b29a"
        fill-opacity=".3"
      />{/each}
    <rect
      x="170"
      y="66"
      width="30"
      height="17"
      rx="3"
      fill="#a4d3bd"
      fill-opacity=".25"
      stroke="#a4d3bd"
      stroke-width={target === "checkout" ? 2 : 0.6}
    /><text x="185" y="78" font-size="9" fill="#d7e5c9" text-anchor="middle"
      >PAY</text
    >
    <path d="M101 145h20" stroke="#c5d1b7" stroke-width="3" />
    <g
      transform={`translate(${110 + position.x * 5.1},${78 + position.z * 4.6}) rotate(${(-position.angle * 180) / Math.PI})`}
      ><circle r="11" fill="#efbb75" opacity=".12" /><path
        d="M0 -7L5 6L0 3L-5 6Z"
        fill="#ffe0a0"
        stroke="#fff1d1"
        stroke-width="1"
      /></g
    >
  </svg>
  <div class="map-foot">
    <span><i></i> You are here</span><button
      onclick={() => navigate("checkout")}>Find checkout ↗</button
    >
  </div>
</div>

<style>
  .mini-map {
    width: 244px;
    padding: 14px 13px 10px;
    background: #243930d9;
    border: 1px solid #ecdfbd30;
    border-radius: 15px;
    backdrop-filter: blur(16px);
    box-shadow: 0 5px 24px #14221c18;
  }
  .map-heading {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 10px;
    letter-spacing: 1.1px;
    font-weight: 700;
    color: #e4e6d5;
  }
  .map-heading > span:last-child {
    margin-left: auto;
    color: #9faf9c;
    font-size: 10px;
  }
  .live-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #eac78b;
  }
  .mini-map svg {
    width: 100%;
    margin-top: 9px;
    display: block;
  }
  .map-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10px;
    color: #c1cbb5;
    padding-top: 8px;
  }
  .map-foot i {
    display: inline-block;
    width: 5px;
    height: 5px;
    background: #f4ce8d;
    border-radius: 50%;
    margin-right: 4px;
  }
  .map-foot button {
    border: 0;
    background: none;
    color: #ecddb6;
    padding: 0;
    font-size: 10px;
  }
  g[role="button"] {
    cursor: pointer;
  }
  g[role="button"]:focus-visible {
    outline: none;
  }
  g[role="button"]:focus-visible rect {
    stroke: #ffe3a8;
    stroke-width: 2.5px;
  }
  @media (max-width: 1100px) {
    .mini-map {
      width: 224px;
    }
  }
  @media (max-width: 700px) {
    .mini-map {
      width: 164px;
      padding: 10px;
    }
    .map-heading {
      font-size: 7px;
    }
    .map-foot {
      font-size: 7px;
    }
    .map-foot button {
      font-size: 7px;
    }
  }
</style>
