// 1.7.11: проверка вёрстки на странице — текст не наезжает на текст, нет горизонтальной прокрутки.
// Возвращает список проблем (пустой — всё в порядке). Видимая часть текста считается с учётом обрезки
// родителями (overflow: hidden / auto), чтобы «Нет задач с установл…» с многоточием не давало ложных срабатываний.
(() => {
  const problems = [];
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) problems.push(`горизонтальная прокрутка: ширина ${document.documentElement.scrollWidth} > ${vw}`);
  const clipOf = el => {
    let box = { l: -1e9, t: -1e9, r: 1e9, b: 1e9 };
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const r = a.getBoundingClientRect();
        box = { l: Math.max(box.l, r.left), t: Math.max(box.t, r.top), r: Math.min(box.r, r.right), b: Math.min(box.b, r.bottom) };
      }
    }
    return box;
  };
  const fixedLayer = el => { for (let a = el; a; a = a.parentElement) if (getComputedStyle(a).position === 'fixed') return true; return false; };
  const items = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent.trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || el.closest('script,style,template,[hidden],dialog:not([open])')) continue;
    if (el.closest('.slogan')) continue;   // «Делаем мир / чище!» — две строки рукописного шрифта, сближены намеренно
    if (fixedLayer(el)) continue;          // плавающие плашки и уведомления лежат поверх страницы намеренно
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue;
    const clip = clipOf(el);
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      const b = { l: Math.max(r.left, clip.l), t: Math.max(r.top, clip.t), r: Math.min(r.right, clip.r), b: Math.min(r.bottom, clip.b) };
      if (b.r - b.l < 2 || b.b - b.t < 2) continue;
      items.push({ el, node, text: text.slice(0, 40), b });
    }
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (A.node === B.node) continue;
      const w = Math.min(A.b.r, B.b.r) - Math.max(A.b.l, B.b.l);
      const h = Math.min(A.b.b, B.b.b) - Math.max(A.b.t, B.b.t);
      // строки одного абзаца могут касаться на 1–2 px — это не наезд
      if (w > 3 && h > 3) problems.push(`«${A.text}» наезжает на «${B.text}» (${Math.round(w)}×${Math.round(h)} px)`);
    }
  }
  return [...new Set(problems)];
})()
