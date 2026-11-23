<script lang="ts">
	import { MessageCircle, Globe2, Send } from 'lucide-svelte';
	import type { WorldSession } from '$lib/game/net/WorldSession.svelte';
	import type { ChatChannel } from '$lib/game/net/protocol';

	let { session, input = $bindable() }: { session: WorldSession; input?: HTMLInputElement } = $props();
	let channel = $state<ChatChannel>('nearby');
	let text = $state('');
	let log: HTMLDivElement;

	$effect(() => {
		void session.chat.length;
		queueMicrotask(() => log?.scrollTo({ top: log.scrollHeight }));
	});

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (session.sendChat(channel, text)) text = '';
		input?.blur();
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			input?.blur();
			event.stopPropagation();
		}
		if (event.key === 'Tab') {
			event.preventDefault();
			channel = channel === 'nearby' ? 'world' : 'nearby';
		}
	}

	const time = (ts: number) =>
		new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const LABEL = { nearby: 'Nearby', world: 'World', system: '', dm: 'DM' } as const;
</script>

<div class="chat pointer-events-auto" data-testid="chat">
	<!-- Messages float on glass over the city; nothing shows until someone talks. -->
	<div bind:this={log} class="chat-log" class:empty={!session.chat.length} aria-live="polite" aria-label="Chat messages" data-testid="chat-log">
		{#each session.chat as line (line.key)}
			<p class="line" class:system={line.channel === 'system'}>
				{#if line.channel !== 'system'}
					<span class="who {line.mine ? 'mine' : line.channel}">{line.name ?? line.from}</span>
					<span class="meta">{LABEL[line.channel]} · {time(line.ts)}</span><br />
				{/if}
				<span class="khmer">{line.text}</span>
			</p>
		{/each}
	</div>
	<form class="chat-bar" class:typing={!!text} onsubmit={submit}>
		<button
			type="button"
			class="channel"
			onclick={() => (channel = channel === 'nearby' ? 'world' : 'nearby')}
			title="Switch channel (Tab)"
			data-testid="chat-channel"
		>
			{#if channel === 'nearby'}<MessageCircle size={14} /> Nearby{:else}<Globe2 size={14} /> World{/if}
		</button>
		<input
			bind:this={input}
			bind:value={text}
			onkeydown={keydown}
			maxlength="280"
			autocomplete="off"
			enterkeyhint="send"
			placeholder={channel === 'nearby' ? 'Talk to players nearby…' : 'Talk to everyone in the city…'}
			aria-label="Chat message"
			data-testid="chat-input"
		/>
		<!-- Which key does what, where you look: Enter to talk; once typing, Tab for the other channel. -->
		<span class="keys" aria-hidden="true">
			<kbd class="key-enter">Enter</kbd>
			<kbd class="key-tab">Tab · {channel === 'nearby' ? 'World' : 'Nearby'}</kbd>
		</span>
		<button class="send" aria-label="Send" disabled={!text.trim()}>
			<Send size={15} />
		</button>
	</form>
</div>

<style>
	.chat { display: grid; gap: 6px; width: min(23rem, calc(100vw - 1.5rem)); }
	.chat-log {
		max-height: 11rem;
		overflow-y: auto;
		padding: 8px 12px;
		border-radius: 16px;
		font-size: 13px;
		line-height: 1.35;
		color: #fffaf0;
		background: rgb(11 37 36 / 0.42);
		-webkit-backdrop-filter: blur(10px) saturate(140%);
		backdrop-filter: blur(10px) saturate(140%);
		border: 1px solid rgb(255 255 255 / 0.12);
		text-shadow: 0 1px 2px rgb(11 37 36 / 0.6);
		scrollbar-width: thin;
		scrollbar-color: rgb(255 255 255 / 0.3) transparent;
	}
	.chat-log.empty { padding: 0; border: 0; background: none; -webkit-backdrop-filter: none; backdrop-filter: none; }
	.line { overflow-wrap: anywhere; }
	.line + .line { margin-top: 4px; }
	.line.system { color: var(--color-saffron-300); font-style: italic; }
	.who { margin-right: 4px; font-weight: 700; color: var(--color-river-200); }
	.who.mine { color: var(--color-saffron-300); }
	.who.dm { color: #c9b8ff; }
	.meta { font-size: 10px; color: rgb(191 224 216 / 0.6); }
	.chat-bar {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 44px;
		padding: 4px;
		border-radius: 999px;
		background: rgb(11 37 36 / 0.5);
		-webkit-backdrop-filter: blur(12px) saturate(140%);
		backdrop-filter: blur(12px) saturate(140%);
		border: 1px solid rgb(255 255 255 / 0.16);
		box-shadow: 0 12px 30px -14px rgb(0 0 0 / 0.6);
		transition: border-color 120ms, background-color 120ms;
	}
	.chat-bar:focus-within { border-color: var(--color-saffron-500); background: rgb(11 37 36 / 0.72); }
	.channel { display: flex; flex: none; align-items: center; gap: 5px; height: 34px; padding: 0 11px 0 9px; border-radius: 999px; font-size: 12px; font-weight: 700; color: #fffaf0; background: rgb(255 255 255 / 0.1); }
	.channel:hover { background: rgb(255 255 255 / 0.18); }
	input { flex: 1; min-width: 0; height: 100%; padding: 0 4px; border: 0; background: transparent; font-size: 15px; color: #fffaf0; }
	input::placeholder { color: rgb(214 226 220 / 0.6); }
	input:focus-visible { outline: none; } /* the bar shows focus */
	.keys { flex: none; display: flex; }
	kbd { padding: 2px 6px; border-radius: 6px; font: 600 10px/14px var(--font-sans); color: rgb(255 250 240 / 0.75); background: rgb(255 255 255 / 0.12); }
	.key-tab, .chat-bar:focus-within .key-enter, .typing .keys { display: none; }
	.chat-bar:focus-within .key-tab { display: inline; }
	.send { display: grid; flex: none; place-items: center; width: 34px; height: 34px; border-radius: 50%; color: var(--color-river-950); background: var(--color-saffron-500); }
	.send:hover:not(:disabled) { background: var(--color-saffron-300); }
	.send:disabled { color: rgb(255 250 240 / 0.45); background: rgb(255 255 255 / 0.1); }
	/* Touch: no keys to press; 16 px text so phones do not zoom into the field. */
	@media (pointer: coarse) {
		.keys { display: none; }
		input { font-size: 16px; }
	}
	@media (prefers-reduced-motion: reduce) { .chat-bar { transition: none; } }
</style>
