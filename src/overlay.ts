/**
 * In-page overlay that makes the agent's actions visible in the run video:
 * a cursor that follows the mouse, a ripple on every click, a pulse on the
 * field being typed into, a scroll arrow, and the action badge.
 *
 * Every overlay element carries `data-probei-overlay`, and screenshots hide
 * them (see OVERLAY_HIDE_CSS), so the model never sees the overlay.
 */
export const OVERLAY_HIDE_CSS = '[data-probei-overlay]{display:none !important}';

declare global {
  interface Window {
    __probeiOverlay?: { badge(text: string): void; clearBadge(): void };
  }
}

/** Runs in every document via context.addInitScript. */
export function installOverlay(): void {
  if (window.__probeiOverlay) return;

  const RED = '#dc2626';
  const css = `
    [data-probei-overlay]{position:fixed;pointer-events:none;z-index:2147483647;}
    #probei-cursor{left:0;top:0;width:26px;height:26px;opacity:0;transform:translate(-100px,-100px);
      transition:opacity .15s;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));}
    #probei-cursor svg{transform-origin:3px 2px;transition:transform .09s ease-out;}
    #probei-cursor.down svg{transform:scale(.8);}
    .probei-ripple{width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;
      border:4px solid ${RED};background:rgba(220,38,38,.18);
      animation:probei-ripple .75s cubic-bezier(.2,.7,.3,1) forwards;}
    .probei-ripple.inner{width:18px;height:18px;margin:-9px 0 0 -9px;border:none;background:${RED};
      animation:probei-dot .9s ease-out forwards;}
    .probei-field{border:3px solid ${RED};border-radius:6px;box-shadow:0 0 0 4px rgba(220,38,38,.25);
      animation:probei-fade .7s ease-out forwards;}
    .probei-scroll{width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;
      background:rgba(17,24,39,.85);color:#fff;font:700 30px/56px system-ui,sans-serif;text-align:center;
      animation:probei-scroll .7s ease-out forwards;}
    #probei-badge{left:50%;bottom:28px;transform:translate(-50%,12px);max-width:80vw;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap;background:rgba(17,24,39,.93);color:#fff;
      font:14px/1.2 system-ui,sans-serif;padding:10px 18px 10px 14px;border-left:5px solid ${RED};
      border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.35);opacity:0;
      transition:opacity .2s ease-out,transform .2s ease-out;}
    #probei-badge.on{opacity:1;transform:translate(-50%,0);}
    @keyframes probei-ripple{0%{transform:scale(.3);opacity:1}100%{transform:scale(1.6);opacity:0}}
    @keyframes probei-dot{0%{transform:scale(1);opacity:1}100%{transform:scale(.4);opacity:0}}
    @keyframes probei-fade{0%{opacity:1}70%{opacity:1}100%{opacity:0}}
    @keyframes probei-scroll{0%{opacity:0;translate:0 calc(var(--dir) * -14px)}
      30%{opacity:1}100%{opacity:0;translate:0 calc(var(--dir) * 22px)}}
  `;

  let cursor: HTMLDivElement | null = null;
  let badge: HTMLDivElement | null = null;
  let mouseX = -100;
  let mouseY = -100;

  const make = (cls = ''): HTMLDivElement => {
    const el = document.createElement('div');
    el.setAttribute('data-probei-overlay', '');
    if (cls) el.className = cls;
    return el;
  };

  const flash = (el: HTMLElement, ms: number): void => {
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), ms);
  };

  const mount = (): void => {
    const style = document.createElement('style');
    style.setAttribute('data-probei-overlay', '');
    style.textContent = css;
    document.documentElement.appendChild(style);

    cursor = make();
    cursor.id = 'probei-cursor';
    cursor.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8 16.5 L11.5 24 L15 22.5 L11.6 15 L18 15 Z"' +
      ' fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cursor);

    badge = make();
    badge.id = 'probei-badge';
    document.documentElement.appendChild(badge);
  };

  const moveCursor = (x: number, y: number): void => {
    mouseX = x;
    mouseY = y;
    if (!cursor) return;
    cursor.style.transform = `translate(${x - 3}px,${y - 2}px)`;
    cursor.style.opacity = '1';
  };

  const opts = { capture: true, passive: true } as const;
  window.addEventListener('mousemove', (e) => moveCursor(e.clientX, e.clientY), opts);
  window.addEventListener(
    'mousedown',
    (e) => {
      moveCursor(e.clientX, e.clientY);
      cursor?.classList.add('down');
      for (const cls of ['probei-ripple', 'probei-ripple inner']) {
        const r = make(cls);
        r.style.left = `${e.clientX}px`;
        r.style.top = `${e.clientY}px`;
        flash(r, 1000);
      }
    },
    opts,
  );
  window.addEventListener('mouseup', () => cursor?.classList.remove('down'), opts);
  window.addEventListener(
    'keydown',
    () => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      document.querySelectorAll('.probei-field').forEach((f) => f.remove());
      const box = make('probei-field');
      box.style.cssText = `left:${rect.left - 4}px;top:${rect.top - 4}px;width:${rect.width + 2}px;height:${rect.height + 2}px`;
      flash(box, 700);
    },
    opts,
  );
  let lastScroll = 0;
  window.addEventListener(
    'wheel',
    (e) => {
      if (Date.now() - lastScroll < 250 || !e.deltaY) return;
      lastScroll = Date.now();
      const dir = e.deltaY > 0 ? 1 : -1;
      const arrow = make('probei-scroll');
      arrow.textContent = dir > 0 ? '↓' : '↑';
      arrow.style.cssText = `left:${mouseX}px;top:${mouseY + 50}px;--dir:${dir}`;
      flash(arrow, 700);
    },
    opts,
  );

  window.__probeiOverlay = {
    badge(text: string) {
      if (!badge) return;
      badge.textContent = text.slice(0, 100);
      badge.classList.add('on');
    },
    clearBadge() {
      badge?.classList.remove('on');
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
