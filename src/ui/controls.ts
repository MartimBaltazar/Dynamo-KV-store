/** Small DOM builders for the free-play panel. No framework, no state. */

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
