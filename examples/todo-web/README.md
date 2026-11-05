# todo-web

A tiny, dependency-free todo app used to demonstrate and test MutationWorkflow's web adapter.
It serves one accessible page backed by a JSON API with in-memory state.

```sh
node server.js            # http://127.0.0.1:4173
PORT=5000 node server.js
```

`mutationworkflow.config.yaml` next to it configures MutationWorkflow for the app: how to start
and reset it, and a `codemap` rule that ties the todo API to `server.js` and `public/app.js`, so
`mw run --changed` knows which workflows a change to either file affects.

| Endpoint                      | Purpose                            |
| ----------------------------- | ---------------------------------- |
| `GET /`                       | The app                            |
| `GET /api/health`             | `200 {"ok":true}`                  |
| `POST /api/reset`             | Restore the two seed todos         |
| `GET/POST /api/todos`         | List / create (`{ "title": "…" }`) |
| `PATCH/DELETE /api/todos/:id` | Update (`title`, `done`) / delete  |

Every normal flow works: add a todo, tick it, edit it with its **Edit** button and **Save**,
delete it. The app also contains three deliberate **sequence bugs**, which only appear when steps
are repeated, reordered or interrupted, exactly the kind of mutation MutationWorkflow applies.

## Planted bugs

### (a) Double submit creates duplicates

1. Type "Buy milk" in **New todo**.
2. Click **Add**.
3. Click **Add** again.

Result: two "Buy milk" todos. The field keeps its text after adding, the client has no
in-flight guard and the server does not reject duplicates. Found by the _repeat_ mutation.

### (b) Delete, then save an edit: HTTP 500

1. Click **Edit Buy milk**.
2. Click **Delete Buy milk**.
3. Click **Save**.

Result: `PATCH /api/todos/:id` returns 500 (a `TypeError` on the server, which never checks
that the todo still exists) and the page logs `console.error("Could not save the todo: …")`.
Found by the _reorder_ mutation (delete moved before save).

### (c) Reload mid-edit, then save: uncaught TypeError

1. Click **Edit Buy milk**.
2. Reload the page.
3. Click **Save**.

Result: the edit form is reset by the reload, but **Save** stays enabled and its handler reads
`editing.id` while `editing` is `null`, throwing
`TypeError: Cannot read properties of null (reading 'id')` in the page. Found by the _interrupt_
mutation (reload inserted between steps).
