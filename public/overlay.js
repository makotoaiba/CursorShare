// ホストPCのデスクトップに重ねる透明ウィンドウ（クリックは下のアプリへ素通り）
import { CursorLayer, wsUrl, micIcon } from '/common.js';

const layer = new CursorLayer(document.querySelector('#layer'));
const toasts = document.querySelector('#toasts');
const speakersEl = document.querySelector('#speakers');
const people = new Map(); // id -> { name, color, speaking }
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

function setPerson(p) {
  people.set(p.id, { name: p.name, color: p.color, speaking: !!p.speaking });
  layer.setPerson(p.id, p.name, p.color);
  layer.setSpeaking(p.id, !!p.speaking);
}

// いま話している人を画面の隅に出す（カーソルが画面の外にあっても、誰の声か分かるように）
function renderSpeakers() {
  speakersEl.replaceChildren(
    ...[...people.values()].filter((p) => p.speaking).map((p) => {
      const el = document.createElement('span');
      el.className = 'speaker';
      el.style.setProperty('--c', p.color);
      el.innerHTML = micIcon(false);
      el.appendChild(document.createTextNode(p.name));
      return el;
    })
  );
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
          people.clear();
          for (const v of m.viewers) setPerson(v);
          renderSpeakers();
          break;
        case 'join': setPerson(m); break;
        case 'leave':
          people.delete(m.id);
          layer.removePerson(m.id);
          renderSpeakers();
          break;
        case 'voice': {
          const p = people.get(m.id);
          if (!p) break;
          p.speaking = !!m.speaking;
          layer.setSpeaking(m.id, p.speaking);
          renderSpeakers();
          break;
        }
        case 'cursor': layer.move(m.id, m.x, m.y); break;
        case 'click': layer.click(m.id, m.x, m.y); break;
        case 'hide': layer.hide(m.id); break;
        case 'stroke': layer.stroke(m.id, m.sid, m.pts, m.end); break;
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

window.__ov = { layer }; // 動作確認用
