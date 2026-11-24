import type { AudioSettings } from './WorldAudio';

export const MUSIC_TRACK = { title: 'Riverside Breeze', url: '/audio/riverside-breeze.mp3' };

/** One native-media loop. Independent of effects and optional Web Audio ambience. */
export class BackgroundMusic {
	private element: HTMLAudioElement | null = null;
	private enabled = false;
	private pending = false;
	private disposed = false;
	private settings: Pick<AudioSettings, 'master' | 'music' | 'muted'> = { master: .6, music: .25, muted: false };
	error = '';
	configure(settings: Pick<AudioSettings, 'master' | 'music' | 'muted'>): void {
		this.settings = { ...settings };
		this.sync();
	}
	unlock(): void {
		if (this.disposed) return;
		this.enabled = true;
		if (!this.element) {
			this.element = new Audio(MUSIC_TRACK.url);
			this.element.loop = true;
			this.element.preload = 'auto';
			this.element.onerror = () => { this.error = 'Background music could not load. Reload the game.'; };
		}
		this.sync();
	}
	private sync(): void {
		const el = this.element;
		if (!el || this.disposed) return;
		const volume = this.settings.muted ? 0 : this.settings.master * this.settings.music;
		el.volume = Math.max(0, Math.min(1, volume));
		if (document.hidden || volume === 0) { el.pause(); return; }
		if (this.enabled && el.paused && !this.pending) {
			this.pending = true;
			void el.play().then(() => {
				this.error = '';
				if (this.disposed || document.hidden || this.settings.muted || this.settings.master*this.settings.music===0) el.pause();
			}).catch(() => { if (!this.disposed) this.error = 'Click the game or Enable sound to start background music.'; })
			.finally(() => { this.pending = false; });
		}
	}
	visibility(): void { this.sync(); }
	diagnostics() {
		return { title: MUSIC_TRACK.title, playing: !!this.element && !this.element.paused,
			time: this.element?.currentTime ?? 0, duration: this.element && Number.isFinite(this.element.duration) ? this.element.duration : 0,
			volume: this.element?.volume ?? 0, ready: this.element?.readyState ?? 0, error: this.error };
	}
	dispose(): void {
		this.disposed = true;
		if (this.element) { this.element.pause(); this.element.removeAttribute('src'); this.element.load(); }
		this.element = null;
	}
}
