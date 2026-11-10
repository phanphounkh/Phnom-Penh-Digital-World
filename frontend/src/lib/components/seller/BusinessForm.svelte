<script lang="ts">
	import { untrack } from 'svelte';
	import { ApiError } from '$lib/api/client';
	import { BUSINESS_CATEGORIES, DAYS, seller, type Hours, type Merchant, type MerchantInput } from '$lib/api/market';

	let { merchant, onsaved }: { merchant: Merchant | null; onsaved: (m: Merchant) => void } = $props();

	const initial = untrack(() => merchant); // the form starts from the saved profile
	let form = $state<MerchantInput>({
		business_name: initial?.business_name ?? '',
		business_name_km: initial?.business_name_km ?? '',
		category: initial?.category ?? 'food_drink',
		description: initial?.description ?? '',
		contact_phone: initial?.contact_phone ?? '',
		contact_email: initial?.contact_email ?? '',
		business_address: initial?.business_address ?? '',
		operating_hours: initial?.operating_hours ?? {}
	});
	const DAY_LABEL: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
	let hours = $state(
		Object.fromEntries(
			DAYS.map((d) => {
				const span = (initial?.operating_hours as Hours | undefined)?.[d]?.[0];
				return [d, { open: !!span || !initial, from: span?.[0] ?? '08:00', to: span?.[1] ?? '20:00' }];
			})
		) as Record<string, { open: boolean; from: string; to: string }>
	);
	let errors = $state<Record<string, string>>({});
	let error = $state('');
	let busy = $state(false);
	let docKind = $state('business_registration');
	let docFile = $state<FileList | null>(null);
	let docNote = $state('');

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		errors = {};
		const operating_hours: Hours = {};
		for (const d of DAYS) if (hours[d].open) operating_hours[d] = [[hours[d].from, hours[d].to]];
		const body = {
			...form,
			business_name_km: form.business_name_km || null,
			description: form.description || null,
			contact_phone: form.contact_phone || null,
			contact_email: form.contact_email || null,
			business_address: form.business_address || null,
			operating_hours
		};
		try {
			onsaved(merchant ? await seller.update(body) : await seller.apply(body));
		} catch (err) {
			if (err instanceof ApiError) {
				errors = err.fieldErrors;
				error = err.fieldErrors._ ?? err.message;
			} else error = 'Could not save.';
		} finally {
			busy = false;
		}
	}

	async function upload() {
		const file = docFile?.[0];
		if (!file) return;
		docNote = '';
		try {
			await seller.uploadDocument(file, docKind);
			onsaved(await seller.merchant());
			docNote = 'Document uploaded. Only administrators can see it.';
			docFile = null;
		} catch (err) {
			docNote = err instanceof ApiError ? err.message : 'Upload failed.';
		}
	}
</script>

<form class="space-y-4" onsubmit={save} data-testid="merchant-form">
	{#if error}<p class="alert-error">{error}</p>{/if}
	<div class="grid gap-3 sm:grid-cols-2">
		<label class="block"><span class="label">Business name</span>
			<input class="input" bind:value={form.business_name} required minlength="2" maxlength="120" name="business_name" />
			{#if errors.business_name}<span class="text-xs text-brick-600">{errors.business_name}</span>{/if}
		</label>
		<label class="block"><span class="label">Name in Khmer (optional)</span>
			<input class="input khmer" lang="km" bind:value={form.business_name_km} maxlength="120" />
		</label>
		<label class="block"><span class="label">Category</span>
			<select class="input" bind:value={form.category}>
				{#each Object.entries(BUSINESS_CATEGORIES) as [value, label] (value)}<option {value}>{label}</option>{/each}
			</select>
		</label>
		<label class="block"><span class="label">Customer phone</span>
			<input class="input" bind:value={form.contact_phone} placeholder="012 345 678" name="contact_phone" />
			{#if errors.contact_phone}<span class="text-xs text-brick-600">{errors.contact_phone}</span>{/if}
		</label>
		<label class="block"><span class="label">Customer e-mail</span>
			<input class="input" type="email" bind:value={form.contact_email} />
		</label>
		<label class="block"><span class="label">Real business address (admins only)</span>
			<input class="input" bind:value={form.business_address} maxlength="300" placeholder="Never shown publicly" />
		</label>
	</div>
	<label class="block"><span class="label">About the business</span>
		<textarea class="input min-h-20" bind:value={form.description} maxlength="600"></textarea>
	</label>
	<fieldset>
		<legend class="label">Opening hours (Phnom Penh time)</legend>
		<div class="grid gap-1.5 sm:grid-cols-2">
			{#each DAYS as d (d)}
				<div class="flex items-center gap-2 text-sm">
					<label class="flex w-16 items-center gap-1.5"><input type="checkbox" bind:checked={hours[d].open} /> {DAY_LABEL[d]}</label>
					<input class="input w-28 py-1.5" type="time" bind:value={hours[d].from} disabled={!hours[d].open} aria-label={`${d} opens`} />
					<span>–</span>
					<input class="input w-28 py-1.5" type="time" bind:value={hours[d].to} disabled={!hours[d].open} aria-label={`${d} closes`} />
				</div>
			{/each}
		</div>
	</fieldset>
	<button class="btn-primary" disabled={busy} data-testid="merchant-submit">{merchant ? 'Save changes' : 'Apply to sell'}</button>
</form>

{#if merchant}
	<div class="mt-6 rounded-2xl bg-paper-2 p-4">
		<p class="font-semibold">Verification documents</p>
		<p class="hint">Business registration, ID, or a lease or utility bill: PDF, JPEG or PNG up to 5 MB. Needed for units at a real, named business. Stored privately; only administrators can open them.</p>
		<ul class="mt-2 space-y-1 text-sm">
			{#each merchant.documents as d (d.id)}
				<li>{d.original_name} · {d.kind.replaceAll('_', ' ')} · <span class="chip">{d.status}</span></li>
			{:else}
				<li class="text-ink-soft">None yet.</li>
			{/each}
		</ul>
		<div class="mt-3 flex flex-wrap items-center gap-2">
			<select class="input w-56 py-2 text-sm" bind:value={docKind}>
				<option value="business_registration">Business registration</option>
				<option value="id_document">ID document</option>
				<option value="lease_or_utility">Lease or utility bill</option>
				<option value="other">Other</option>
			</select>
			<input type="file" accept="application/pdf,image/jpeg,image/png" bind:files={docFile} class="text-sm" />
			<button class="btn-ghost py-2" type="button" onclick={upload} disabled={!docFile?.length}>Upload</button>
		</div>
		{#if docNote}<p class="mt-2 text-xs">{docNote}</p>{/if}
	</div>
{/if}
