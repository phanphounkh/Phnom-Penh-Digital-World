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

<div class="pointer-events-auto w-[min(24rem,calc(100vw-1.5rem))]" data-testid="chat">
	<div
		bind:this={log}
		class="mb-2 max-h-48 space-y-0.5 overflow-y-auto rounded-xl bg-river-950/55 px-3 py-2 text-[13px] leading-snug backdrop-blur [scrollbar-width:thin]"
		aria-live="polite"
		aria-label="Chat messages"
		data-testid="chat-log"
	>
		{#if !session.chat.length}
			<p class="text-xs text-river-200/80">Press <kbd class="rounded bg-white/15 px-1">Enter</kbd> to talk to players nearby. Tab switches to the whole world.</p>
		{/if}
		{#each session.chat as line (line.key)}
			<p class="break-words {line.channel === 'system' ? 'text-saffron-300 italic' : ''}">
				{#if line.channel !== 'system'}
					<span class="mr-1 text-[10px] tracking-wide text-river-200/70 uppercase">{LABEL[line.channel]}</span>
					<span class="font-semibold {line.mine ? 'text-saffron-300' : line.channel === 'dm' ? 'text-[#c9b8ff]' : 'text-river-200'}">{line.name ?? line.from}</span>
					<span class="text-[10px] text-river-200/50">{time(line.ts)}</span><br />
				{/if}
				<span class="khmer">{line.text}</span>
			</p>
		{/each}
	</div>
	<form class="flex gap-1.5" onsubmit={submit}>
		<button
			type="button"
			class="flex shrink-0 items-center gap-1 rounded-xl bg-river-950/75 px-2.5 text-xs font-semibold text-paper backdrop-blur hover:bg-river-800"
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
			class="min-w-0 flex-1 rounded-xl border border-white/15 bg-river-950/75 px-3 py-2 text-sm text-paper placeholder:text-river-200/60 backdrop-blur focus:border-saffron-500 focus:outline-none"
			placeholder={channel === 'nearby' ? 'Say something to players nearby…' : 'Message everyone in this room…'}
			aria-label="Chat message"
			data-testid="chat-input"
		/>
		<button class="grid w-10 shrink-0 place-items-center rounded-xl bg-saffron-500 text-river-950 hover:bg-saffron-300" aria-label="Send" disabled={!text.trim()}>
			<Send size={15} />
		</button>
	</form>
</div>
