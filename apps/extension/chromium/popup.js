const api = globalThis.browser ?? globalThis.chrome;
const enabled = document.querySelector('#enabled');
const connections = document.querySelector('#connections');
const notifications = document.querySelector('#notifications');
const download = document.querySelector('#download');
const ping = document.querySelector('#ping');
const status = document.querySelector('#status');

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = kind;
}

async function load() {
  try {
    const settings = await api.runtime.sendMessage({ type: 'get-settings' });
    enabled.checked = settings.interceptionEnabled;
    connections.value = String(settings.connections);
    notifications.checked = settings.showNotifications;
    setStatus('Subutai integration бэлэн.', 'ok');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function save() {
  try {
    await api.runtime.sendMessage({
      type: 'set-settings',
      interceptionEnabled: enabled.checked,
      connections: Number(connections.value),
      showNotifications: notifications.checked,
    });
    setStatus('Тохиргоо хадгалагдлаа.', 'ok');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
}

enabled.addEventListener('change', () => void save());
connections.addEventListener('change', () => void save());
notifications.addEventListener('change', () => void save());

download.addEventListener('click', () => {
  download.disabled = true;
  setStatus('Subutai руу илгээж байна…');
  void api.runtime.sendMessage({ type: 'download-current-tab' })
    .then(() => setStatus('Таталт Subutai-д нэмэгдлээ.', 'ok'))
    .catch((error) => setStatus(error instanceof Error ? error.message : String(error), 'error'))
    .finally(() => { download.disabled = false; });
});

ping.addEventListener('click', () => {
  ping.disabled = true;
  setStatus('Desktop app шалгаж байна…');
  void api.runtime.sendMessage({ type: 'ping' })
    .then((response) => {
      if (!response?.ok) throw new Error(response?.error || 'Desktop app олдсонгүй.');
      setStatus('Subutai desktop app холбогдлоо.', 'ok');
    })
    .catch((error) => setStatus(error instanceof Error ? error.message : String(error), 'error'))
    .finally(() => { ping.disabled = false; });
});

void load();
