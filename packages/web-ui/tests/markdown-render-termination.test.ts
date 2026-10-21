import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// renderMarkdownToElement used to spin forever (creating empty <p> nodes) on a line that looks
// like a table start but does not parse as a table, freezing the tab and growing its memory.
const src = readFileSync(fileURLToPath(new URL('../src/static/app.js', import.meta.url)), 'utf8');

function extract(name: string): string {
  const fn = new RegExp(`(^|\\n)function\\s+${name}\\s*\\(`).exec(src);
  if (!fn) {
    const c = new RegExp(`(^|\\n)const\\s+${name}\\s*=`).exec(src);
    if (!c) throw new Error(`missing ${name}`);
    const start = c.index + c[1].length;
    return src.slice(start, src.indexOf(';\n', start) + 1);
  }
  let i = src.indexOf('{', fn.index + fn[0].length);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(fn.index + fn[1].length, i + 1);
}

function loadRenderer(): (el: any, text: string) => void {
  const fakeDom = `
    class N { constructor(t){ this.tagName=t; this.children=[]; this.attrs={}; this.className=''; this.textContent=''; this.style={}; this.dataset={};
      this.classList={ add(){}, remove(){}, toggle(){}, contains(){ return false; } }; }
      appendChild(c){ this.children.push(c); return c; } append(...c){ this.children.push(...c); } setAttribute(k,v){ this.attrs[k]=v; } addEventListener(){} }
    const document = { createElement: (t) => new N(t), createTextNode: (t) => { const n = new N('#text'); n.textContent = t; return n; }, createDocumentFragment: () => new N('#frag') };`;
  const names = new Set(['renderMarkdownToElement', 'parseMarkdownTable', 'renderInlineMarkdown']);
  for (let attempt = 0; attempt < 30; attempt++) {
    const body = `${fakeDom}\n${[...names].map(extract).join('\n')}\nreturn renderMarkdownToElement;`;
    const render = new Function(body)();
    try {
      render({ appendChild() {} }, 'probe **text**\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
      return render;
    } catch (e) {
      const m = /(\w+) is not defined/.exec(String(e));
      if (!m || names.has(m[1])) throw e;
      names.add(m[1]);
    }
  }
  throw new Error('could not load renderer');
}

describe('renderMarkdownToElement', () => {
  it('terminates on a pipe line whose next line is not a valid table delimiter', () => {
    const render = loadRenderer();
    const out: any[] = [];
    render({ appendChild: (c: any) => { out.push(c); return c; } }, 'a | b\nnot-a-delimiter | x\nafter');
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(10);
  });
});
