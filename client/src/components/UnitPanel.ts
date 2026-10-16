import { STATUS_COLORS } from '../scenes/FloorScene';
import { formatPrice } from '../format';
import type { Unit } from '../types';

export interface UnitPanelOptions {
  /** Send a buyer's hold request. Rejects with an Error whose message is shown to the buyer. */
  requestHold: (unit: Unit, details: { name: string; phone: string; note?: string }) => Promise<void>;
}

const FACING_NAMES: Record<string, string> = { N: 'north', S: 'south', E: 'east', W: 'west', NE: 'north-east', NW: 'north-west', SE: 'south-east', SW: 'south-west' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Slide-in unit details for buyers, with a "request this unit" form when it's available.
 * All buyer-visible text is set via textContent.
 */
export class UnitPanel {
  private readonly root = el('aside', 'unit-panel');
  private unit: Unit | null = null;
  private sent = new Set<string>(); // units this visitor already requested, this session

  constructor(container: HTMLElement, private readonly opts: UnitPanelOptions) {
    this.root.hidden = true;
    this.root.setAttribute('aria-live', 'polite');
    container.append(this.root);
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && !this.root.hidden) this.close(); });
  }

  get current(): Unit | null { return this.unit; }

  open(unit: Unit): void {
    this.unit = unit;
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    this.root.hidden = true;
    this.unit = null;
  }

  /** Re-render after a live change (status or price) to the open unit, keeping what the buyer typed. */
  refresh(): void {
    if (this.unit && !this.root.hidden) this.render(true);
  }

  private render(keepForm = false): void {
    const u = this.unit!;
    const draft = keepForm ? this.readDraft() : null;

    const close = el('button', 'up-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.close());

    const status = el('span', 'up-status', u.status);
    status.style.color = STATUS_COLORS[u.status];

    const facts = el('dl', 'up-facts');
    const fact = (k: string, v: string) => facts.append(el('dt', '', k), el('dd', '', v));
    fact('Price', u.price > 0 ? formatPrice(u.price) : 'On request');
    fact('Area', `${u.area_sqm} m²`);
    fact('Bedrooms', String(u.bedrooms));
    fact('Bathrooms', String(u.bathrooms));
    fact('Faces', FACING_NAMES[u.facing] ?? u.facing);

    const rooms = el('ul', 'up-rooms');
    for (const r of [...u.rooms].sort((a, b) => b.area_sqm - a.area_sqm)) {
      const li = el('li', '', r.label ?? r.type);
      li.append(el('span', 'muted', ` ${r.area_sqm.toFixed(1)} m²`));
      rooms.append(li);
    }

    this.root.replaceChildren(
      close,
      el('h2', '', u.unit_code),
      status,
      facts,
      u.rooms.length ? rooms : '',
      this.renderAction(u, draft),
    );
  }

  private renderAction(u: Unit, draft: { name: string; phone: string; note: string } | null): HTMLElement {
    if (this.sent.has(u.id)) {
      return el('p', 'up-done', 'Thank you — a sales agent will call you shortly about this unit.');
    }
    if (u.status !== 'available') {
      return el('p', 'muted', u.status === 'reserved'
        ? 'This unit is reserved. Ask the sales office to join the waiting list.'
        : 'This unit has been sold.');
    }

    const form = el('form', 'up-form');
    const field = (label: string, input: HTMLInputElement | HTMLTextAreaElement) => {
      const l = el('label', '', label);
      l.append(input);
      form.append(l);
    };
    const name = Object.assign(el('input'), { name: 'name', required: true, autocomplete: 'name', maxLength: 100, value: draft?.name ?? '' });
    const phone = Object.assign(el('input'), { name: 'phone', type: 'tel', required: true, autocomplete: 'tel', maxLength: 30, value: draft?.phone ?? '', placeholder: '+966 5x xxx xxxx' });
    const note = Object.assign(el('textarea'), { name: 'note', rows: 2, maxLength: 500, value: draft?.note ?? '', placeholder: 'Optional — e.g. best time to call' });
    form.append(el('h3', '', 'Interested? Request this unit'));
    field('Name', name);
    field('Phone', phone);
    field('Note', note);
    const error = el('p', 'up-error');
    error.hidden = true;
    const submit = el('button', 'primary', 'Request a call back');
    submit.type = 'submit';
    form.append(error, submit, el('p', 'up-privacy', 'We only use your details to contact you about this unit.'));

    form.addEventListener('submit', async e => {
      e.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      try {
        await this.opts.requestHold(u, { name: name.value.trim(), phone: phone.value.trim(), note: note.value.trim() || undefined });
        this.sent.add(u.id);
        this.render();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
        error.hidden = false;
        submit.disabled = false;
      }
    });
    return form;
  }

  private readDraft(): { name: string; phone: string; note: string } | null {
    const form = this.root.querySelector('form');
    if (!form) return null;
    const v = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '';
    return { name: v('name'), phone: v('phone'), note: v('note') };
  }
}
