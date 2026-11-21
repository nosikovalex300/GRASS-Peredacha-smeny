/*
 * GRASS — Передача смены · лента комментариев задачи (1.7.6, п. 26 плана)
 *
 * Новый комментарий добавляется в ленту t.comments, а не затирает прежний. t.comment — последний
 * комментарий (его показывает карточка, по нему работают сводка и старые версии программы).
 * У задач до 1.7.6 ленты нет: нынешний комментарий становится её первой записью, автора и время
 * берём из истории — событие, с которого этот комментарий появился.
 * Тесты — tests/comments.test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GrassComments = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX = 200;   // столько последних комментариев храним в задаче

  function clean(v) { return String(v || '').trim(); }

  // history — события этой задачи, новые сверху (как в истории программы).
  function legacyEntry(t, history) {
    var text = clean(t.comment);
    if (!text) return null;
    var from = null;
    (history || []).some(function (h) {
      if (clean(h.comment) !== text) return true;    // дошли до события, где комментарий был другим
      from = h; return false;
    });
    return { text: text, author: from ? from.author || '' : t.author || '', shift: from ? from.shift || '' : t.shift || '',
      at: from ? from.at || from.when || '' : t.date || '' };
  }

  // Лента задачи, старые сверху.
  function feedOf(t, history) {
    if (!t) return [];
    if (Array.isArray(t.comments) && t.comments.length) {
      var list = t.comments.filter(function (c) { return c && clean(c.text); });
      // задачу правили в старой версии программы: комментарий поменялся мимо ленты — допишем его
      var last = list[list.length - 1];
      if (clean(t.comment) && (!last || clean(last.text) !== clean(t.comment))) {
        var extra = legacyEntry(t, history); if (extra) list = list.concat([extra]);
      }
      return list;
    }
    var first = legacyEntry(t, history);
    return first ? [first] : [];
  }

  // Новая лента после ввода text. Пустой или такой же, как последний, — ленту не меняем (null).
  function append(t, text, who, history) {
    text = clean(text);
    var feed = feedOf(t, history);
    if (!text || (feed.length && clean(feed[feed.length - 1].text) === text)) return null;
    return feed.concat([{ text: text, author: who.author || '', shift: who.shift || '', at: who.at || '' }]).slice(-MAX);
  }

  function searchText(t) {
    return (Array.isArray(t && t.comments) ? t.comments : []).map(function (c) { return c && c.text || ''; }).join('\n');
  }

  return { MAX: MAX, feedOf: feedOf, append: append, searchText: searchText };
});
