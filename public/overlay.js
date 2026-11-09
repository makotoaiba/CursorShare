// ホストPCのデスクトップに重ねる透明ウィンドウ（クリックは下のアプリへ素通り）
import { CursorLayer, wsUrl } from '/common.js';

const layer = new CursorLayer(document.querySelector('#layer'));
const toasts = document.querySelector('#toasts');
let chain = Promise.resolve();

function toast(m) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.style.setProperty('--c', m.color);
  const b = document.createElement('b');
  b.textContent = m.name;
  t.append(b, document.createTextNode(m.text));
  toasts.appendChild(t);
  t.addEventListener('animationend', () => t.remove());
  while (toasts.children.length > 5) toasts.firstElementChild.remove();
}

function connect() {
  const ws = new WebSocket(wsUrl());
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'overlay' }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    chain = chain.then(() => {
      switch (m.type) {
        case 'welcome':
          layer.clear();
          for (const v of m.viewers) layer.setPerson(v.id, v.name, v.color);
          break;
        case 'join': layer.setPerson(m.id, m.name, m.color); break;
        case 'leave': layer.removePerson(m.id); break;
        case 'cursor': layer.move(m.id, m.x, m.y); break;
        case 'click': layer.click(m.id, m.x, m.y); break;
        case 'hide': layer.hide(m.id); break;
        case 'react': layer.react(m.id, m.emoji, m.x, m.y); break;
        case 'chat':
          layer.say(m.id, m.text);
          if (m.color !== '#5c6672') toast(m); // ホスト自身の発言は出さない
          break;
        case 'host':
          if (!m.sharing) layer.clear();
          break;
      }
    });
  };
  ws.onclose = () => setTimeout(connect, 2000);
}
connect();
