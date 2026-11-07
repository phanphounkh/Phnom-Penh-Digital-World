<script lang="ts">
	import '../app.css';
	import { session } from '$lib/stores/session.svelte';
	let { data, children } = $props();
	// Hydrate the shared session store from the layout load (runs on every navigation).
	$effect.pre(() => session.set(data.user));
</script>

{@render children()}
