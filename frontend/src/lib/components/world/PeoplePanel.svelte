<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { UserPlus, MessageSquare, Send, VolumeX, Volume2, Ban, Flag, ArrowLeft, Check, X, Navigation } from 'lucide-svelte';
	import { social } from '$lib/api/endpoints';
	import { ApiError } from '$lib/api/client';
	import type { Conversation, DirectMessage, Friend, ReportReason } from '$lib/api/types';
	import type { WorldSession } from '$lib/game/net/WorldSession.svelte';

	let { session, initialTab = 'nearby' }: { session: WorldSession; initialTab?: Tab } = $props();
	type Tab = 'nearby' | 'friends' | 'messages' | 'blocked';
	let tab = $state<Tab>(untrack(() => initialTab));
	let friends = $state<Friend[]>([]);
	let conversations = $state<Conversation[]>([]);
	let relations = $state<{ blocked: string[]; muted: string[] }>({ blocked: [], muted: [] });
	let thread = $state<{ username: string; name: string; messages: DirectMessage[] } | null>(null);
	let draft = $state('');
	let addName = $state('');
	let selected = $state<string | null>(null);
	let reporting = $state<string | null>(null);
	let reportReason = $state<ReportReason>('harassment');
	let reportDetails = $state('');
	let notice = $state('');

	async function refresh() {
		try {
			[friends, conversations, relations] = await Promise.all([social.friends(), social.conversations(), social.relations()]);
			if (thread) thread.messages = await social.thread(thread.username);
		} catch {
			/* offline: keep the last lists */
		}
	}
	onMount(refresh);
	$effect(() => {
		void session.socialVersion;
		refresh();
	});

	const friendOf = (u: string) => friends.find((f) => f.username === u);

	async function act(fn: () => Promise<unknown>, ok?: string) {
		notice = '';
		try {
			const r = (await fn()) as { message?: string } | undefined;
			notice = ok ?? r?.message ?? '';
			await refresh();
		} catch (e) {
			notice = e instanceof ApiError ? e.message : 'Something went wrong.';
		}
	}

	async function openThread(username: string, name: string) {
		tab = 'messages';
		thread = { username, name, messages: [] };
		thread.messages = await social.thread(username);
		conversations = await social.conversations();
	}

	async function sendDraft(event: SubmitEvent) {
		event.preventDefault();
		if (!thread || !draft.trim()) return;
		const text = draft;
		draft = '';
		await act(() => social.sendMessage(thread!.username, text), '');
	}

	async function submitReport(event: SubmitEvent) {
		event.preventDefault();
		const who = reporting!;
		await act(() => social.report(who, reportReason, reportDetails || undefined));
		reporting = null;
		reportDetails = '';
	}

	const TABS: [Tab, string][] = [['nearby', 'Nearby'], ['friends', 'Friends'], ['messages', 'Messages'], ['blocked', 'Blocked']];
	const REASONS: [ReportReason, string][] = [
		['harassment', 'Harassment or bullying'], ['hate', 'Hate speech'], ['spam', 'Spam or scams'],
		['cheating', 'Cheating or exploits'], ['inappropriate_name', 'Inappropriate name or avatar'], ['other', 'Something else']
	];
	const unread = $derived(conversations.reduce((n, c) => n + c.unread, 0));
	const incoming = $derived(friends.filter((f) => f.status === 'incoming').length);
</script>

{#snippet actions(username: string, name: string)}
	{@const friend = friendOf(username)}
	{@const muted = relations.muted.includes(username)}
	<div class="mt-2 flex flex-wrap gap-1.5" data-testid={`actions-${username}`}>
		{#if !friend}
			<button class="chip py-1.5" onclick={() => act(() => social.addFriend(username))}><UserPlus size={13} /> Add friend</button>
		{:else if friend.status === 'accepted'}
			<button class="chip py-1.5" onclick={() => session.invite(username)}><Navigation size={13} /> Invite here</button>
		{/if}
		<button class="chip py-1.5" onclick={() => openThread(username, name)}><MessageSquare size={13} /> Message</button>
		<button class="chip py-1.5" onclick={() => act(() => (muted ? social.unmute(username) : social.mute(username)))}>
			{#if muted}<Volume2 size={13} /> Unmute{:else}<VolumeX size={13} /> Mute{/if}
		</button>
		<button class="chip py-1.5 text-brick-600" onclick={() => act(() => social.block(username), `@${username} is blocked. You will not see each other.`)}><Ban size={13} /> Block</button>
		<button class="chip py-1.5 text-brick-600" onclick={() => (reporting = username)}><Flag size={13} /> Report</button>
	</div>
{/snippet}

<div class="flex h-full flex-col" data-testid="people-panel">
	<div class="grid grid-cols-4 gap-1 rounded-xl bg-paper-2 p-1 text-xs font-semibold" role="tablist">
		{#each TABS as [id, label] (id)}
			<button role="tab" aria-selected={tab === id} class="relative rounded-lg py-2 {tab === id ? 'bg-white shadow' : 'text-ink-soft'}" onclick={() => { tab = id; thread = null; }}>
				{label}
				{#if id === 'messages' && unread}<span class="absolute -top-1 right-1 rounded-full bg-brick-500 px-1.5 text-[10px] text-white">{unread}</span>{/if}
				{#if id === 'friends' && incoming}<span class="absolute -top-1 right-1 rounded-full bg-saffron-500 px-1.5 text-[10px] text-river-950">{incoming}</span>{/if}
			</button>
		{/each}
	</div>
	{#if notice}<p class="mt-2 rounded-lg bg-paper-2 px-3 py-2 text-xs" role="status">{notice}</p>{/if}

	<div class="mt-3 min-h-0 flex-1 overflow-y-auto">
		{#if reporting}
			<form class="space-y-3" onsubmit={submitReport}>
				<p class="text-sm font-semibold">Report @{reporting}</p>
				<select class="input py-2 text-sm" bind:value={reportReason} aria-label="Reason">
					{#each REASONS as [id, label] (id)}<option value={id}>{label}</option>{/each}
				</select>
				<textarea class="input text-sm" rows="3" maxlength="1000" placeholder="What happened? (optional)" bind:value={reportDetails}></textarea>
				<p class="hint">Moderators will see this report and @{reporting}'s recent public chat. Consider blocking them too.</p>
				<div class="flex gap-2"><button class="btn-primary flex-1 py-2">Send report</button><button type="button" class="btn-ghost py-2" onclick={() => (reporting = null)}>Cancel</button></div>
			</form>
		{:else if tab === 'nearby'}
			{#if !session.nearby.length}
				<p class="text-sm text-ink-soft">No other players nearby right now. Players appear here when they are within about 300 m and visible.</p>
			{/if}
			<ul class="space-y-1.5" data-testid="nearby-list">
				{#each session.nearby as p (p.id)}
					<li class="rounded-xl border border-river-900/10 bg-white px-3 py-2">
						<button class="flex w-full items-center justify-between text-left" onclick={() => (selected = selected === p.username ? null : p.username)}>
							<span><span class="font-semibold">{p.name}</span> <span class="text-xs text-ink-soft">@{p.username}</span></span>
							<span class="text-xs text-ink-soft">{Math.round(p.distance)} m</span>
						</button>
						{#if selected === p.username}{@render actions(p.username, p.name)}{/if}
					</li>
				{/each}
			</ul>
		{:else if tab === 'friends'}
			<form class="mb-3 flex gap-2" onsubmit={(e) => { e.preventDefault(); const u = addName.trim(); addName = ''; act(() => social.addFriend(u)); }}>
				<input class="input py-2 text-sm" placeholder="Add a friend by username" bind:value={addName} aria-label="Friend username" />
				<button class="btn-primary px-3 py-2" disabled={addName.trim().length < 3} aria-label="Send friend request"><UserPlus size={16} /></button>
			</form>
			{#if !friends.length}<p class="text-sm text-ink-soft">No friends yet. Add players you meet from the Nearby tab.</p>{/if}
			<ul class="space-y-1.5" data-testid="friends-list">
				{#each friends as f (f.username)}
					<li class="rounded-xl border border-river-900/10 bg-white px-3 py-2 text-sm">
						<div class="flex items-center gap-2">
							<span class="h-2 w-2 rounded-full {f.online ? 'bg-emerald-500' : 'bg-ink-soft/30'}" title={f.online ? 'Online' : 'Offline'}></span>
							<span class="flex-1"><span class="font-semibold">{f.display_name}</span> <span class="text-xs text-ink-soft">@{f.username}</span></span>
							{#if f.status === 'incoming'}
								<button class="chip py-1" onclick={() => act(() => social.accept(f.username), 'Friend added')}><Check size={12} /> Accept</button>
								<button class="chip py-1" onclick={() => act(() => social.decline(f.username), 'Request declined')} aria-label="Decline"><X size={12} /></button>
							{:else if f.status === 'outgoing'}
								<span class="text-xs text-ink-soft">Request sent</span>
							{:else}
								{#if f.online}<button class="chip py-1" onclick={() => session.invite(f.username)}><Navigation size={12} /> Invite</button>{/if}
								<button class="chip py-1" onclick={() => openThread(f.username, f.display_name)} aria-label="Message"><MessageSquare size={12} /></button>
								<button class="chip py-1" onclick={() => act(() => social.unfriend(f.username), 'Friend removed')} aria-label="Remove friend"><X size={12} /></button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{:else if tab === 'messages'}
			{#if thread}
				<button class="btn-quiet mb-2 -ml-2 px-2 py-1 text-xs" onclick={() => (thread = null)}><ArrowLeft size={14} /> All conversations</button>
				<p class="mb-2 text-sm font-semibold">{thread.name} <span class="font-normal text-ink-soft">@{thread.username}</span></p>
				<div class="space-y-1.5" data-testid="dm-thread">
					{#each thread.messages as m, i (i)}
						<p class="khmer max-w-[85%] rounded-2xl px-3 py-1.5 text-sm {m.from_me ? 'ml-auto bg-river-900 text-paper' : 'bg-paper-2'}">{m.text}</p>
					{/each}
				</div>
				<form class="mt-3 flex gap-2" onsubmit={sendDraft}>
					<input class="input py-2 text-sm" maxlength="280" placeholder="Write a message…" bind:value={draft} aria-label="Direct message" />
					<button class="btn-primary px-3 py-2" aria-label="Send message" disabled={!draft.trim()}><Send size={16} /></button>
				</form>
			{:else}
				{#if !conversations.length}<p class="text-sm text-ink-soft">No messages yet.</p>{/if}
				<ul class="space-y-1.5">
					{#each conversations as c (c.username)}
						<li>
							<button class="w-full rounded-xl border border-river-900/10 bg-white px-3 py-2 text-left text-sm" onclick={() => openThread(c.username, c.display_name)}>
								<span class="flex justify-between"><span class="font-semibold">{c.display_name}</span>{#if c.unread}<span class="rounded-full bg-brick-500 px-2 text-[11px] text-white">{c.unread}</span>{/if}</span>
								<span class="khmer block truncate text-xs text-ink-soft">{c.from_me ? 'You: ' : ''}{c.last}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<p class="label">Blocked</p>
			{#if !relations.blocked.length}<p class="mb-3 text-sm text-ink-soft">Nobody.</p>{/if}
			{#each relations.blocked as u (u)}
				<div class="mb-1.5 flex items-center justify-between rounded-xl bg-white px-3 py-2 text-sm">@{u}<button class="chip py-1" onclick={() => act(() => social.unblock(u), `@${u} unblocked`)}>Unblock</button></div>
			{/each}
			<p class="label mt-3">Muted</p>
			{#if !relations.muted.length}<p class="text-sm text-ink-soft">Nobody.</p>{/if}
			{#each relations.muted as u (u)}
				<div class="mb-1.5 flex items-center justify-between rounded-xl bg-white px-3 py-2 text-sm">@{u}<button class="chip py-1" onclick={() => act(() => social.unmute(u), `@${u} unmuted`)}>Unmute</button></div>
			{/each}
			<p class="hint mt-3">Blocking hides you from each other in the world and stops messages and friend requests. Muting only hides their chat from you.</p>
		{/if}
	</div>
</div>
