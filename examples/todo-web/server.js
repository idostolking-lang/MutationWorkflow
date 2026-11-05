// Tiny todo app for MutationWorkflow demos and tests. Zero dependencies, in-memory state.
//
// It contains three deliberate SEQUENCE bugs (see README.md). Every normal flow works; the bugs
// only show up when actions are repeated, reordered or interrupted.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4173);
const HOST = '127.0.0.1';

const SEED = ['Read the docs', 'Water the plants'];

/** @type {{ id: number, title: string, done: boolean }[]} */
let todos = [];
let nextId = 1;

function reset() {
  todos = SEED.map((title, index) => ({ id: index + 1, title, done: false }));
  nextId = todos.length + 1;
}
reset();

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Todos</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; }
  ul { list-style: none; padding: 0; }
  li { display: flex; gap: .5rem; align-items: center; padding: .25rem 0; }
  li label { flex: 1; }
  fieldset { margin-top: 1.5rem; }
  [role=status] { min-height: 1.5em; color: #555; }
</style>
</head>
<body>
<main>
  <h1>Todos</h1>
  <form id="add-form" aria-label="Add todo">
    <label for="new-title">New todo</label>
    <input id="new-title" name="title" autocomplete="off" required>
    <button type="submit">Add</button>
  </form>
  <p role="status" id="status"></p>
  <ul role="list" aria-label="Todo items" id="list"></ul>
  <form id="edit-form" aria-label="Edit todo" autocomplete="off">
    <fieldset>
      <legend id="edit-legend">Edit todo (choose one with its Edit button)</legend>
      <label for="edit-title">Title</label>
      <input id="edit-title" name="title" autocomplete="off">
      <button type="submit">Save</button>
      <button type="button" id="cancel-edit">Cancel</button>
    </fieldset>
  </form>
</main>
<script>
  const list = document.getElementById('list');
  const status = document.getElementById('status');
  const addForm = document.getElementById('add-form');
  const newTitle = document.getElementById('new-title');
  const editForm = document.getElementById('edit-form');
  const editTitle = document.getElementById('edit-title');
  const editLegend = document.getElementById('edit-legend');

  /** The todo being edited, or null. Lives only in memory, so a reload forgets it. */
  let editing = null;

  async function api(method, path, body) {
    const response = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(method + ' ' + path + ' failed with HTTP ' + response.status);
    return response.status === 204 ? null : response.json();
  }

  function say(text) {
    status.textContent = text;
  }

  function startEdit(todo) {
    editing = todo;
    editTitle.value = todo.title;
    editLegend.textContent = 'Editing "' + todo.title + '"';
    editTitle.focus();
  }

  function stopEdit() {
    editing = null;
    editTitle.value = '';
    editLegend.textContent = 'Edit todo (choose one with its Edit button)';
  }

  function render(todos) {
    list.replaceChildren(
      ...todos.map((todo) => {
        const item = document.createElement('li');
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = todo.done;
        box.addEventListener('change', () => toggle(todo, box.checked));
        label.append(box, ' ' + todo.title);
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = 'Edit';
        edit.setAttribute('aria-label', 'Edit ' + todo.title);
        edit.addEventListener('click', () => startEdit(todo));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.setAttribute('aria-label', 'Delete ' + todo.title);
        remove.addEventListener('click', () => removeTodo(todo));
        item.append(label, edit, remove);
        return item;
      }),
    );
  }

  async function refresh() {
    render(await api('GET', '/api/todos'));
  }

  async function toggle(todo, done) {
    await api('PATCH', '/api/todos/' + todo.id, { done });
    await refresh();
  }

  async function removeTodo(todo) {
    await api('DELETE', '/api/todos/' + todo.id);
    // BUG (b): the edit form keeps pointing at the deleted todo.
    say('Deleted "' + todo.title + '"');
    await refresh();
  }

  // BUG (a): no in-flight guard and the field is kept for quick re-entry, so pressing Add
  // twice creates the same todo twice; the server does not reject duplicates either.
  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = newTitle.value.trim();
    if (!title) return;
    await api('POST', '/api/todos', { title });
    say('Added "' + title + '"');
    await refresh();
  });

  editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    // BUG (c): assumes a todo is selected. After a reload \`editing\` is null and this throws.
    const id = editing.id;
    const title = editTitle.value.trim();
    if (!title) return;
    try {
      await api('PATCH', '/api/todos/' + id, { title });
      say('Saved "' + title + '"');
      stopEdit();
      await refresh();
    } catch (error) {
      console.error('Could not save the todo:', error.message);
      say('Could not save the todo');
    }
  });

  document.getElementById('cancel-edit').addEventListener('click', stopEdit);

  refresh().catch((error) => {
    console.error('Could not load todos:', error.message);
    say('Could not load todos');
  });
</script>
</body>
</html>
`;

/** Read and parse a JSON request body. */
async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function send(response, status, body, type = 'application/json') {
  const payload =
    body === undefined ? '' : type === 'application/json' ? JSON.stringify(body) : body;
  response.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
  });
  response.end(payload);
}

async function handle(request, response) {
  const { pathname } = new URL(request.url ?? '/', `http://${HOST}`);
  const method = request.method ?? 'GET';
  const itemMatch = /^\/api\/todos\/(\d+)$/.exec(pathname);

  if (method === 'GET' && pathname === '/') return send(response, 200, PAGE, 'text/html');
  if (method === 'GET' && pathname === '/api/health') return send(response, 200, { ok: true });
  if (method === 'POST' && pathname === '/api/reset') {
    reset();
    return send(response, 200, { ok: true, todos });
  }
  if (method === 'GET' && pathname === '/api/todos') return send(response, 200, todos);
  if (method === 'POST' && pathname === '/api/todos') {
    const { title } = await readJson(request);
    if (typeof title !== 'string' || !title.trim()) {
      return send(response, 400, { error: 'title is required' });
    }
    const todo = { id: nextId++, title: title.trim(), done: false };
    todos.push(todo);
    return send(response, 201, todo);
  }
  if (itemMatch && method === 'DELETE') {
    const id = Number(itemMatch[1]);
    const index = todos.findIndex((todo) => todo.id === id);
    if (index === -1) return send(response, 404, { error: 'not found' });
    todos.splice(index, 1);
    return send(response, 204);
  }
  if (itemMatch && method === 'PATCH') {
    const id = Number(itemMatch[1]);
    const changes = await readJson(request);
    // BUG (b): no existence check, so a deleted id throws a TypeError and becomes a 500.
    const todo = todos.find((item) => item.id === id);
    if (typeof changes.title === 'string') todo.title = changes.title.trim();
    if (typeof changes.done === 'boolean') todo.done = changes.done;
    return send(response, 200, todo);
  }
  return send(response, 404, { error: 'not found' });
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(`${request.method} ${request.url}:`, error);
    if (!response.headersSent) send(response, 500, { error: String(error.message ?? error) });
    else response.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`todo-web listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
