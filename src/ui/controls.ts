/** Small DOM builders for the sidebar. No framework, no state. */

export function section(parent: HTMLElement, title: string): HTMLElement {
  const s = document.createElement('section');
  const h = document.createElement('h2');
  h.textContent = title;
  s.appendChild(h);
  parent.appendChild(s);
  return s;
}

export function row(parent: HTMLElement): HTMLElement {
  const r = document.createElement('div');
  r.className = 'row';
  parent.appendChild(r);
  return r;
}

export function hint(parent: HTMLElement, text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  parent.appendChild(p);
  return p;
}

export function button(parent: HTMLElement, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = cls;
  b.addEventListener('click', onClick);
  parent.appendChild(b);
  return b;
}

export interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
}

export function slider(parent: HTMLElement, spec: SliderSpec, onInput: (v: number) => void): HTMLInputElement {
  const wrap = document.createElement('label');
  wrap.className = 'slider';
  const name = document.createElement('span');
  name.textContent = spec.label;
  const out = document.createElement('output');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.value);
  const format = spec.format ?? String;
  out.textContent = format(spec.value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = format(v);
    onInput(v);
  });
  wrap.append(name, out, input);
  parent.appendChild(wrap);
  return input;
}

export function numberField(parent: HTMLElement, label: string, value: number, onChange: (v: number) => void): HTMLInputElement {
  const wrap = document.createElement('label');
  wrap.className = 'row';
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(value);
  input.addEventListener('change', () => onChange(Number(input.value) || 0));
  wrap.append(name, input);
  parent.appendChild(wrap);
  return input;
}

/** A definition list whose values are updated by key. */
export function readout(parent: HTMLElement, labels: Record<string, string>): (values: Record<string, string>) => void {
  const dl = document.createElement('dl');
  const cells = new Map<string, HTMLElement>();
  for (const [key, label] of Object.entries(labels)) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dl.append(dt, dd);
    cells.set(key, dd);
  }
  parent.appendChild(dl);
  return (values) => {
    for (const [key, value] of Object.entries(values)) {
      const cell = cells.get(key);
      if (cell && cell.textContent !== value) cell.textContent = value;
    }
  };
}
