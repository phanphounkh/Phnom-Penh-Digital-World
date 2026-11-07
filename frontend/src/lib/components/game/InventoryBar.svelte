<script>
  let { cart = [], held = null, inspect = () => {} } = $props();
</script>

<div class="inventory-wrap">
  <div class="inventory-label">
    <span>YOUR LITTLE HAUL</span><span
      >{held ? "CARRYING AN ITEM" : "FRESH FINDS. GOOD TIMES."}</span
    >
  </div>
  <div class="inventory-slots">
    {#each Array(6) as _, i}<button
        class:filled={!!cart[i]}
        class:held={i === cart.length && held}
        class="inventory-slot"
        onclick={inspect}
        aria-label={cart[i]
          ? `Inspect ${cart[i].name}`
          : held && i === cart.length
            ? `Carrying ${held.name}`
            : "Empty inventory slot"}
        >{#if cart[i]}<span>{cart[i].icon}</span><small>×1</small
          >{:else if held && i === cart.length}<span>{held.icon}</span><small
            >HAND</small
          >{:else}<span class="plus">＋</span>{/if}<em>{i + 1}</em></button
      >{/each}
    {#if cart.length > 6}<button class="extra" onclick={inspect}
        >+{cart.length - 6}</button
      >{/if}
  </div>
</div>

<style>
  .inventory-wrap {
    padding: 11px 13px 12px;
    background: #263930d9;
    border: 1px solid #e1d9bb40;
    backdrop-filter: blur(18px);
    border-radius: 15px;
    box-shadow: 0 8px 30px #14221c22;
  }
  .inventory-label {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 1.3px;
    color: #ede5cb;
    margin-bottom: 9px;
  }
  .inventory-label span:last-child {
    font-size: 9px;
    color: #a9b7a1;
    letter-spacing: 1px;
  }
  .inventory-slots {
    display: flex;
    gap: 7px;
  }
  .inventory-slot {
    position: relative;
    width: 57px;
    height: 55px;
    border: 1px solid #c7c7a936;
    background: #e9e5c407;
    border-radius: 9px;
    color: #eee6cd;
    display: grid;
    place-items: center;
  }
  .inventory-slot > span {
    font-size: 29px;
    filter: drop-shadow(0 3px 4px #0003);
  }
  .inventory-slot .plus {
    font-size: 23px;
    color: #a9b59b55;
  }
  .inventory-slot em {
    position: absolute;
    top: 4px;
    left: 6px;
    font-size: 9px;
    font-style: normal;
    color: #d4d8bc60;
  }
  .inventory-slot small {
    position: absolute;
    bottom: 4px;
    right: 5px;
    font-size: 9px;
  }
  .inventory-slot.filled {
    background: #e7bc7230;
    border-color: #e7bd7270;
  }
  .inventory-slot.held {
    border-color: #eec57b;
    border-style: dashed;
  }
  .extra {
    background: none;
    color: #f5d49a;
    border: 0;
  }
  @media (max-width: 700px) {
    .inventory-label span:last-child {
      display: none;
    }
    .inventory-slot {
      width: 36px;
      height: 42px;
    }
    .inventory-slot > span {
      font-size: 22px;
    }
    .inventory-slots {
      gap: 4px;
    }
    .inventory-wrap {
      padding: 9px;
    }
    .inventory-label {
      font-size: 9px;
      letter-spacing: 1px;
    }
  }
</style>
