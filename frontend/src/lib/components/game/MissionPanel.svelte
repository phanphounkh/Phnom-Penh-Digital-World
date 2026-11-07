<script>
  import { Check, ChevronDown, Star } from "lucide-svelte";
  let { visited = [], paid = false, points = 0 } = $props();
  let showCompleted = $state(false);
  let missions = $derived([
    {
      name: "Enjoy your first meal",
      done: paid,
      progress: paid ? "1/1" : "0/1",
    },
    {
      name: "Discover two kitchens",
      done: visited.length >= 2,
      progress: Math.min(2, visited.length) + "/2",
    },
    {
      name: "Collect 100 food points",
      done: points >= 100,
      progress: Math.min(100, points) + "/100",
    },
  ]);
  let completed = $derived(missions.filter((m) => m.done).length);
</script>

<section class="mission glass" aria-label="Campus missions">
  <div class="section-label">
    <span class="sun-icon">✧</span> A TASTE OF CAMPUS
    <span class="mission-count">{completed}/3</span>
  </div>
  <h2>
    {completed === 3 ? "A campus well tasted." : "Good food. Great finds."}
  </h2>
  <p>
    {completed === 3
      ? "All three milestones complete. Enjoy your next meal."
      : "A little exploring goes a long way."}
  </p>
  {#each missions.filter((m) => showCompleted || !m.done) as mission}<div
      class:completed={mission.done}
      class="mission-row"
    >
      <span class="check-box"
        >{#if mission.done}<Check size={11} />{/if}</span
      >{mission.name}<small>{mission.progress}</small>
    </div>{/each}
  <div
    class="mission-progress"
    role="progressbar"
    aria-label="Mission progress"
    aria-valuenow={completed}
    aria-valuemin="0"
    aria-valuemax="3"
  >
    <span style={`width:${(completed / 3) * 100}%`}></span>
  </div>
  {#if completed}<button
      class="mission-completed"
      aria-expanded={showCompleted}
      onclick={() => (showCompleted = !showCompleted)}
      >{showCompleted
        ? "Hide completed"
        : `Show completed (${completed})`}<ChevronDown
        size={12}
        style={`transform:rotate(${showCompleted ? 180 : 0}deg)`}
      /></button
    >{:else}<div class="reward-note">
      <Star size={10} /> GOOD TASTE HAS ITS REWARDS
    </div>{/if}
</section>
