import { createResearchAnimation } from './animation';

export function defineOpenAssayPreview() {
  if (customElements.get('aw-openassay-preview')) return;

  class OpenAssayPreview extends HTMLElement {
    private readonly draw = createResearchAnimation();
    private elapsed = 0;
    private cleanup: (() => void) | undefined;

    connectedCallback() {
      if (this.cleanup) return;

      const canvas = this.querySelector('canvas');
      const context = canvas?.getContext('2d');
      if (!canvas || !context) return;

      const events = new AbortController();
      let width = 0;
      let height = 0;
      let pointerX = 0;
      let pointerY = 0;
      let frame = 0;
      let lastTime: number | undefined;
      let lastPaint = -Infinity;
      let inView = false;
      let disposed = false;
      let transitioning = false;

      const render = () => {
        if (!width || !height || disposed) return;
        this.draw(context, width, height, this.elapsed, pointerX, pointerY);
        this.dataset.ready = '';
      };

      const stop = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        lastTime = undefined;
      };

      const canAnimate = () =>
        !disposed && !transitioning && this.isConnected && inView && !document.hidden && width > 0 && height > 0;

      const tick = (now: number) => {
        frame = 0;
        if (!canAnimate()) {
          lastTime = undefined;
          return;
        }
        if (lastTime !== undefined) this.elapsed += Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
        lastTime = now;
        if (now - lastPaint >= 1000 / 30) {
          render();
          lastPaint = now;
        }
        frame = requestAnimationFrame(tick);
      };

      const sync = () => {
        if (canAnimate()) {
          if (!frame) frame = requestAnimationFrame(tick);
        } else {
          stop();
        }
      };

      const resize = () => {
        const bounds = this.getBoundingClientRect();
        width = bounds.width;
        height = bounds.height;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const pixelWidth = Math.round(width * pixelRatio);
        const pixelHeight = Math.round(height * pixelRatio);
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
          canvas.width = pixelWidth;
          canvas.height = pixelHeight;
          context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        }
        render();
        sync();
      };

      this.addEventListener(
        'pointermove',
        (event) => {
          if (event.pointerType === 'touch') return;
          const bounds = this.getBoundingClientRect();
          if (!bounds.width || !bounds.height) return;
          pointerX = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1));
          pointerY = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1));
        },
        { passive: true, signal: events.signal }
      );
      this.addEventListener(
        'pointerleave',
        () => {
          pointerX = 0;
          pointerY = 0;
        },
        { passive: true, signal: events.signal }
      );
      document.addEventListener('visibilitychange', sync, { signal: events.signal });
      document.addEventListener(
        'astro:before-swap',
        () => {
          transitioning = true;
          stop();
        },
        { signal: events.signal }
      );
      document.addEventListener(
        'astro:page-load',
        () => {
          transitioning = false;
          resize();
        },
        { signal: events.signal }
      );
      window.addEventListener('resize', resize, { passive: true, signal: events.signal });

      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(this);
      const intersectionObserver = new IntersectionObserver(
        (entries) => {
          inView = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0);
          sync();
        },
        { threshold: [0, 0.01] }
      );
      intersectionObserver.observe(this);

      this.cleanup = () => {
        disposed = true;
        stop();
        events.abort();
        resizeObserver.disconnect();
        intersectionObserver.disconnect();
      };

      resize();
    }

    disconnectedCallback() {
      this.cleanup?.();
      this.cleanup = undefined;
    }
  }

  customElements.define('aw-openassay-preview', OpenAssayPreview);
}
