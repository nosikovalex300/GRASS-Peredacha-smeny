// Выполняется в странице ДО её скриптов, как preload в Electron: запускает настоящий preload.js.
(function () {
  function call(kind, channel, args) {
    const x = new XMLHttpRequest();
    x.open('POST', '/__' + kind, false);
    x.setRequestHeader('Content-Type', 'application/json');
    x.send(JSON.stringify({ channel, args }));
    const r = JSON.parse(x.responseText);
    if (r.error && kind === 'sync') throw new Error(r.error);
    return r.undef ? undefined : r.value;
  }
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (k, v) => { window[k] = v; } },
    ipcRenderer: {
      sendSync: (ch, ...a) => call('sync', ch, a),
      invoke: (ch, ...a) => fetch('/__invoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: ch, args: a }) }).then(r => r.json()).then(r => { if (r.error) throw new Error(r.error); return r.undef ? undefined : r.value; }),
      on() {}, removeListener() {}
    }
  };
  const x = new XMLHttpRequest(); x.open('GET', '/__preload.js', false); x.send();
  new Function('require', x.responseText)(n => { if (n === 'electron') return fakeElectron; throw new Error('preload require ' + n); });
})();
