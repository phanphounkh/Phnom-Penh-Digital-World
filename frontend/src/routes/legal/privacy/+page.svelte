<svelte:head><title>Privacy Policy (draft) · Phnom Penh Digital World</title></svelte:head>
<main class="street-grid min-h-dvh px-5 py-10">
	<article class="card mx-auto max-w-2xl space-y-4 text-sm leading-relaxed">
		<p class="alert-dev">DRAFT for development. Not reviewed by a lawyer.</p>
		<h1 class="display text-3xl font-bold">Privacy Policy</h1>
		<h2 class="font-semibold">What we store</h2>
		<ul class="list-disc space-y-1 pl-5">
			<li>Account: username, display name, email and/or phone, a salted Argon2 password hash, language.</li>
			<li>Avatar choices and the public spawn area you pick.</li>
			<li>Private delivery addresses you add (coordinates and text).</li>
			<li>Security records: active sessions (IP address, browser), and an audit log of account actions. Audit entries never contain your address or coordinates.</li>
			<li>Multiplayer: your world sessions (connection times and your avatar's last <em>virtual</em> position, so you can resume where you left off), friends, blocks and mutes.</li>
			<li>Chat: nearby, world and direct messages are stored so moderators can act on reports. A report includes the reported player's recent public chat and any messages they sent the reporter. (Development build: no automatic deletion yet; a retention period will be set before launch.)</li>
			<li>Selling: your business name, category, description, customer contact details, opening hours and the real business address you give. Verification documents are stored privately and only administrators can open them (each download is logged).</li>
			<li>Shopping: your cart, orders (items, prices, status history) and demo payments. No card or bank details are collected: payments are simulated.</li>
			<li>Product photos are re-encoded when uploaded, which removes hidden metadata such as the camera's GPS location.</li>
		</ul>
		<h2 class="font-semibold">Who can see it</h2>
		<ul class="list-disc space-y-1 pl-5">
			<li>Other players see only your username, display name, avatar and public role badges — and only if you chose to be visible.</li>
			<li>Delivery addresses are visible only to you. In later phases, the necessary delivery details will be shared only with a driver assigned to your order.</li>
			<li>We do not use your device's GPS. Your avatar's position in the world is never your real location.</li>
			<li>Your online status is shown only to accepted friends, and only while you are visible. Hidden players are never shown to anyone.</li>
			<li>Shops show their name, products, prices, opening hours and the owner's username (so customers can message them). The real business address is never shown publicly.</li>
			<li>A merchant sees the username of a buyer and what they ordered, never the buyer's delivery address in this version (pickup only).</li>
			<li>Nearby chat reaches players within about 40 m; world chat reaches everyone in your room; direct messages reach only the recipient (and moderators, if reported).</li>
		</ul>
		<h2 class="font-semibold">Your controls</h2>
		<p>You can change visibility, edit your avatar, delete addresses, block or mute players and sign out other sessions at any time.</p>
	</article>
</main>
