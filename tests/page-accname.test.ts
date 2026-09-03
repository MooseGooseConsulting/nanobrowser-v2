// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { computeAccessibleName, computeRole, headingLevel, implicitRole } from '@/src/page/accname';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

function one(html: string, selector: string): Element {
  const el = mount(html).querySelector(selector);
  if (!el) throw new Error(`no element matched ${selector}`);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('computeRole', () => {
  it('prefers the explicit role attribute over the native mapping', () => {
    expect(computeRole(one('<button role="link">x</button>', 'button'))).toBe('link');
    expect(implicitRole(one('<button role="link">x</button>', 'button'))).toBe('button');
  });

  it('takes the first token of a space-separated role fallback list', () => {
    expect(computeRole(one('<div role="doohickey button">x</div>', 'div'))).toBe('doohickey');
  });

  it('normalises presentation to none', () => {
    expect(computeRole(one('<img role="presentation" alt="x">', 'img'))).toBe('none');
  });

  it.each([
    ['<a href="/x">go</a>', 'a', 'link'],
    ['<a>go</a>', 'a', 'generic'],
    ['<button>go</button>', 'button', 'button'],
    ['<input type="text">', 'input', 'textbox'],
    ['<input>', 'input', 'textbox'],
    ['<input type="search">', 'input', 'searchbox'],
    ['<input type="checkbox">', 'input', 'checkbox'],
    ['<input type="radio">', 'input', 'radio'],
    ['<input type="number">', 'input', 'spinbutton'],
    ['<input type="range">', 'input', 'slider'],
    ['<input type="submit">', 'input', 'button'],
    ['<input type="hidden">', 'input', 'none'],
    ['<textarea></textarea>', 'textarea', 'textbox'],
    ['<select></select>', 'select', 'combobox'],
    ['<select multiple></select>', 'select', 'listbox'],
    ['<select size="4"></select>', 'select', 'listbox'],
    ['<select><option>a</option></select>', 'option', 'option'],
    ['<img alt="cat">', 'img', 'img'],
    ['<img alt="">', 'img', 'none'],
    ['<h3>t</h3>', 'h3', 'heading'],
    ['<nav></nav>', 'nav', 'navigation'],
    ['<main></main>', 'main', 'main'],
    ['<aside></aside>', 'aside', 'complementary'],
    ['<ul><li>a</li></ul>', 'ul', 'list'],
    ['<ul><li>a</li></ul>', 'li', 'listitem'],
    ['<table><tr><td>c</td></tr></table>', 'td', 'cell'],
    ['<hr>', 'hr', 'separator'],
    ['<p>t</p>', 'p', 'paragraph'],
  ])('maps %s (%s) to role %s', (html, selector, role) => {
    expect(computeRole(one(html, selector))).toBe(role);
  });

  it('maps header/footer to landmarks only at body scope', () => {
    expect(computeRole(one('<header>h</header>', 'header'))).toBe('banner');
    expect(computeRole(one('<article><header>h</header></article>', 'header'))).toBe('generic');
    expect(computeRole(one('<footer>f</footer>', 'footer'))).toBe('contentinfo');
    expect(computeRole(one('<section><footer>f</footer></section>', 'footer'))).toBe('generic');
  });

  it('makes section a region only when it carries a name', () => {
    expect(computeRole(one('<section>s</section>', 'section'))).toBe('generic');
    expect(computeRole(one('<section aria-label="Filters">s</section>', 'section'))).toBe('region');
  });

  it('reads heading level from the tag or aria-level', () => {
    expect(headingLevel(one('<h4>t</h4>', 'h4'))).toBe(4);
    expect(headingLevel(one('<div role="heading" aria-level="2">t</div>', 'div'))).toBe(2);
    expect(headingLevel(one('<p>t</p>', 'p'))).toBe(0);
  });
});

describe('computeAccessibleName', () => {
  it('uses aria-labelledby before everything else', () => {
    const el = one(
      '<span id="lbl">Real name</span><button aria-labelledby="lbl" aria-label="ignored" title="also ignored">text</button>',
      'button',
    );
    expect(computeAccessibleName(el)).toBe('Real name');
  });

  it('concatenates multiple aria-labelledby targets in order', () => {
    const el = one('<span id="a">Delete</span><span id="b">item 3</span><button aria-labelledby="a b"></button>', 'button');
    expect(computeAccessibleName(el)).toBe('Delete item 3');
  });

  it('does not loop on a self-referential aria-labelledby', () => {
    const el = one('<button id="me" aria-labelledby="me">Fallback</button>', 'button');
    expect(computeAccessibleName(el)).toBe('Fallback');
  });

  it('uses aria-label when there is no labelledby', () => {
    expect(computeAccessibleName(one('<button aria-label="Close">x</button>', 'button'))).toBe('Close');
  });

  it('names a text input from its <label for>', () => {
    const el = one('<label for="e">Email address</label><input id="e" type="email">', 'input');
    expect(computeAccessibleName(el)).toBe('Email address');
  });

  it('names a text input from a wrapping <label>', () => {
    const el = one('<label>Full name <input type="text"></label>', 'input');
    expect(computeAccessibleName(el)).toBe('Full name');
  });

  it('falls back to title then placeholder for an unlabelled input', () => {
    expect(computeAccessibleName(one('<input title="Search here" placeholder="q">', 'input'))).toBe('Search here');
    expect(computeAccessibleName(one('<input placeholder="you@example.com">', 'input'))).toBe('you@example.com');
  });

  it('names a button from its subtree text', () => {
    expect(computeAccessibleName(one('<button><span>Add</span> to cart</button>', 'button'))).toBe('Add to cart');
  });

  it('collapses whitespace inside a content-derived name', () => {
    expect(computeAccessibleName(one('<button>  Add\n\t  to   cart  </button>', 'button'))).toBe('Add to cart');
  });

  it('names an image from alt', () => {
    expect(computeAccessibleName(one('<img alt="A grey cat" title="t">', 'img'))).toBe('A grey cat');
  });

  it('uses the value attribute for submit and reset, with spec defaults', () => {
    expect(computeAccessibleName(one('<input type="submit" value="Send it">', 'input'))).toBe('Send it');
    expect(computeAccessibleName(one('<input type="submit">', 'input'))).toBe('Submit');
    expect(computeAccessibleName(one('<input type="reset">', 'input'))).toBe('Reset');
  });

  it('names an option from its text and an optgroup from its label', () => {
    const html = '<select><optgroup label="Sizes"><option value="m">Medium</option></optgroup></select>';
    expect(computeAccessibleName(one(html, 'option'))).toBe('Medium');
    expect(computeAccessibleName(one(html, 'optgroup'))).toBe('Sizes');
  });

  it('names a link from its content', () => {
    expect(computeAccessibleName(one('<a href="/cart">View cart (3)</a>', 'a'))).toBe('View cart (3)');
  });

  it('names a fieldset from its legend and a table from its caption', () => {
    expect(computeAccessibleName(one('<fieldset><legend>Shipping</legend></fieldset>', 'fieldset'))).toBe('Shipping');
    expect(computeAccessibleName(one('<table><caption>Orders</caption></table>', 'table'))).toBe('Orders');
  });

  it('names an iframe from its title', () => {
    expect(computeAccessibleName(one('<iframe title="Payment form"></iframe>', 'iframe'))).toBe('Payment form');
  });

  it('skips aria-hidden and display:none content when naming from the subtree', () => {
    const el = one('<button>Keep <span aria-hidden="true">drop</span><span hidden>gone</span></button>', 'button');
    expect(computeAccessibleName(el)).toBe('Keep');
  });

  it('returns an empty name rather than inventing one', () => {
    expect(computeAccessibleName(one('<div></div>', 'div'))).toBe('');
  });
});
